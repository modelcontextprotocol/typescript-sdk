/**
 * Protocol-layer tests: cancellation, errors, progress, timeouts, custom methods.
 *
 * Tests covering the request/response lifecycle independent of specific MCP
 * features like tools or resources. Most test both McpServer and raw Server
 * via the requirement's tier map.
 */

import { Client } from '@modelcontextprotocol/client';
import type {
    CallToolRequest,
    JSONRPCMessage,
    JSONRPCNotification,
    JSONRPCRequest,
    JSONRPCResponse,
    MessageExtraInfo,
    Notification,
    Progress,
    RequestId,
    Result,
    Transport,
    TransportSendOptions
} from '@modelcontextprotocol/server';
import {
    InMemoryTransport,
    isJSONRPCResultResponse,
    McpServer,
    ProtocolError,
    ProtocolErrorCode,
    SdkError,
    SdkErrorCode,
    Server,
    specTypeSchemas
} from '@modelcontextprotocol/server';
import { expect, vi } from 'vitest';
import { z } from 'zod/v4';

import { tapWire, wire } from '../helpers/index.js';
import { verifies } from '../helpers/verifies.js';
import type { TestArgs } from '../types.js';

const newClient = () => new Client({ name: 'c', version: '0' });

/** Raw {@link Server} factory whose tools/list never resolves — for timeout / connection-closed tests. */
function neverRespondingServer(): Server {
    const s = new Server({ name: 's', version: '0' }, { capabilities: { tools: {} } });
    s.setRequestHandler(
        'tools/list',
        () =>
            new Promise(() => {
                /* never resolves */
            })
    );
    return s;
}

const isRequest = (m: JSONRPCMessage): m is JSONRPCRequest => 'method' in m && 'id' in m;
const isNotification = (m: JSONRPCMessage): m is JSONRPCNotification => 'method' in m && !('id' in m);
const isResponse = (m: JSONRPCMessage): m is JSONRPCResponse => 'id' in m && !('method' in m);

/**
 * Tap `client.transport.send` so every outbound JSON-RPC message is recorded.
 * Call after `wire()` so the transport is set.
 */
function tapOutbound(client: Client): JSONRPCMessage[] {
    const out: JSONRPCMessage[] = [];
    const tx = client.transport;
    if (!tx) throw new Error('tapOutbound: client not connected');
    const orig = tx.send.bind(tx);
    tx.send = async (m, opts) => {
        out.push(m);
        return orig(m, opts);
    };
    return out;
}

verifies('protocol:cancel:abort-signal', async ({ transport }: TestArgs) => {
    const stalled: Array<() => void> = [];
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool(
            'echo',
            { inputSchema: z.object({ text: z.string() }) },
            async ({ text }, ctx) =>
                new Promise(resolve => {
                    const t = setTimeout(() => resolve({ content: [{ type: 'text', text }] }), 60_000);
                    t.unref();
                    stalled.push(() => {
                        clearTimeout(t);
                        resolve({ content: [{ type: 'text', text: 'late' }] });
                    });
                    ctx.mcpReq.signal.addEventListener('abort', () => {
                        clearTimeout(t);
                    });
                })
        );
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const outbound = tapOutbound(client);

    const controller = new AbortController();
    const call = client.callTool(
        { name: 'echo', arguments: { text: 'never' } },
        {
            signal: controller.signal
        }
    );
    call.catch(() => {});

    await vi.waitFor(() => expect(outbound.some(m => 'method' in m && m.method === 'tools/call')).toBe(true));
    const callMsg = outbound.filter(m => isRequest(m)).find(m => m.method === 'tools/call');
    if (!callMsg) throw new Error('tools/call request not captured');

    controller.abort('user requested cancellation');

    await expect(call).rejects.toThrow(/user requested cancellation/);

    await vi.waitFor(() => expect(outbound.some(m => 'method' in m && m.method === 'notifications/cancelled')).toBe(true));
    const cancelled = outbound.find(m => 'method' in m && m.method === 'notifications/cancelled');

    expect(cancelled).toBeDefined();
    expect(cancelled).not.toHaveProperty('id');
    if (!cancelled || !('params' in cancelled)) throw new Error('notifications/cancelled message has no params');
    expect(cancelled.params?.requestId).toBe(callMsg.id);
    expect(cancelled.params?.reason).toContain('user requested cancellation');
});

verifies('protocol:cancel:http-stream-close', async ({ transport }: TestArgs) => {
    // 2026-07-28 Streamable HTTP: closing the per-request SSE stream IS the
    // cancel signal — no notifications/cancelled is sent on the wire. The body
    // proves both the caller-signal and timeout paths route to stream-close.
    const client = newClient();
    await using _ = await wire(transport, neverRespondingServer, client);

    // Tap send to record outbound messages AND the per-request requestSignal
    // the protocol layer hands the transport.
    const sent: Array<{ m: JSONRPCMessage; opts: TransportSendOptions | undefined }> = [];
    const tx = client.transport;
    if (!tx) throw new Error('client not connected');
    expect(tx.hasPerRequestStream).toBe(true);
    const orig = tx.send.bind(tx);
    tx.send = async (m, opts) => {
        sent.push({ m, opts });
        return orig(m, opts);
    };

    // Caller-signal abort.
    const ac = new AbortController();
    const call = client.listTools(undefined, { signal: ac.signal });
    await vi.waitFor(() => expect(sent.some(s => isRequest(s.m) && s.m.method === 'tools/list')).toBe(true));
    const listSend = sent.find(s => isRequest(s.m) && s.m.method === 'tools/list');
    if (!listSend) throw new Error('tools/list send not captured');
    expect(listSend.opts?.requestSignal, 'protocol layer must thread a per-request requestSignal on a 2026 HTTP connection').toBeInstanceOf(
        AbortSignal
    );
    expect(listSend.opts?.requestSignal?.aborted).toBe(false);

    ac.abort('user requested cancellation');
    await expect(call).rejects.toThrow(/user requested cancellation/);

    expect(listSend.opts?.requestSignal?.aborted, 'stream-close IS the cancel signal: requestSignal must be aborted').toBe(true);
    expect(
        sent.filter(s => isNotification(s.m) && s.m.method === 'notifications/cancelled'),
        'no notifications/cancelled on the wire — "not required or expected" per spec'
    ).toHaveLength(0);

    // Timeout path.
    sent.length = 0;
    vi.useFakeTimers();
    try {
        const pending = client.listTools(undefined, { timeout: 100 });
        pending.catch(() => {});
        await vi.advanceTimersByTimeAsync(100);
        await expect(pending).rejects.toMatchObject({ code: SdkErrorCode.RequestTimeout });
    } finally {
        vi.useRealTimers();
    }
    const timedOutSend = sent.find(s => isRequest(s.m) && s.m.method === 'tools/list');
    if (!timedOutSend) throw new Error('timeout-path tools/list send not captured');
    expect(timedOutSend.opts?.requestSignal?.aborted).toBe(true);
    expect(sent.filter(s => isNotification(s.m) && s.m.method === 'notifications/cancelled')).toHaveLength(0);
});

verifies('protocol:cancel:handler-abort-propagates', async ({ transport }: TestArgs) => {
    const aborts: Array<{ requestId: RequestId; reason: unknown }> = [];
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool(
            'cancellable',
            { inputSchema: z.object({}) },
            async (_a, ctx) =>
                new Promise((resolve, reject) => {
                    ctx.mcpReq.signal.addEventListener('abort', () => {
                        aborts.push({ requestId: ctx.mcpReq.id, reason: ctx.mcpReq.signal.reason });
                        reject(new Error(ctx.mcpReq.signal.reason));
                    });
                })
        );
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const ac = new AbortController();
    const call = client.callTool({ name: 'cancellable', arguments: {} }, { signal: ac.signal });
    call.catch(() => {});

    await new Promise(resolve => setTimeout(resolve, 50));

    ac.abort(new Error('user cancelled'));

    await expect(call).rejects.toThrow('user cancelled');

    await vi.waitFor(() => expect(aborts.length).toBeGreaterThan(0));

    const firstAbort = aborts[0];
    if (!firstAbort) throw new Error('no abort recorded');
    // Server-side signal.reason carries the cancellation reason text from the
    // notifications/cancelled the client sent (possibly wrapped).
    expect(String(firstAbort.reason)).toContain('user cancelled');
});

verifies('protocol:cancel:initialize-not-cancellable', async (_: TestArgs) => {
    // This test must tap outbound messages BEFORE connect() completes (to see the
    // initialize request and any cancelled notification). wire() awaits connect, so
    // it can't be used here. Tested on inMemory only — the behavior is in
    // shared/protocol.ts and is transport-agnostic.
    const [clientTx] = InMemoryTransport.createLinkedPair();
    // No server attached: initialize will hang, giving us a window to abort.

    const outbound: JSONRPCMessage[] = [];
    const origSend = clientTx.send.bind(clientTx);
    clientTx.send = async (m, opts) => {
        outbound.push(m);
        return origSend(m, opts);
    };

    const client = newClient();
    const ac = new AbortController();
    const connecting = client.connect(clientTx, { signal: ac.signal });
    connecting.catch(() => {});

    await vi.waitFor(() => expect(outbound.filter(m => isRequest(m)).some(m => m.method === 'initialize')).toBe(true));
    const initReq = outbound.filter(m => isRequest(m)).find(m => m.method === 'initialize');
    expect(initReq?.id).toBeDefined();

    ac.abort(new Error('user aborted connect'));
    await expect(connecting).rejects.toThrow();

    await new Promise(resolve => setTimeout(resolve, 50));

    const cancelledForInit = outbound
        .filter(m => isNotification(m))
        .filter(m => m.method === 'notifications/cancelled' && m.params?.requestId === initReq?.id);
    expect(cancelledForInit).toEqual([]);

    await client.close();
});

verifies('protocol:cancel:late-response-ignored', async ({ transport }: TestArgs) => {
    const stalled: Array<() => void> = [];
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool(
            'echo',
            { inputSchema: z.object({ text: z.string() }) },
            async ({ text }) =>
                new Promise(resolve => {
                    const t = setTimeout(() => resolve({ content: [{ type: 'text', text }] }), 60_000);
                    t.unref();
                    stalled.push(() => {
                        clearTimeout(t);
                        resolve({ content: [{ type: 'text', text: 'late' }] });
                    });
                })
        );
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const outbound = tapOutbound(client);

    const errors: Error[] = [];
    client.onerror = e => errors.push(e);

    const ac = new AbortController();
    const call = client.callTool({ name: 'echo', arguments: { text: 'late' } }, { signal: ac.signal });
    call.catch(() => {});

    await vi.waitFor(() => expect(outbound.some(m => 'method' in m && m.method === 'tools/call')).toBe(true));
    const callReq = outbound.filter(m => isRequest(m)).find(m => m.method === 'tools/call');
    if (!callReq) throw new Error('tools/call request not captured');
    const callId = callReq.id;

    ac.abort(new Error('user cancelled'));

    await vi.waitFor(() => expect(outbound.some(m => 'method' in m && m.method === 'notifications/cancelled')).toBe(true));

    await expect(call).rejects.toThrow('user cancelled');

    const lateResponse: JSONRPCMessage = {
        jsonrpc: '2.0',
        id: callId,
        result: { content: [{ type: 'text', text: 'late' }] }
    };
    const clientTx = client.transport;
    if (!clientTx) throw new Error('client transport not connected');
    clientTx.onmessage?.(lateResponse);

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(errors).toEqual([]);

    await expect(client.ping()).resolves.toBeDefined();
});

verifies('protocol:cancel:unknown-id-ignored', async ({ transport }: TestArgs) => {
    const errors: Error[] = [];
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.server.onerror = e => errors.push(e);
        s.registerTool('echo', { inputSchema: z.object({ text: z.string() }) }, ({ text }) => ({
            content: [{ type: 'text', text }]
        }));
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const result = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
    expect(result.content).toEqual([{ type: 'text', text: 'hi' }]);

    await expect(
        client.notification({
            method: 'notifications/cancelled',
            params: { requestId: 99_999, reason: 'unknown numeric id' }
        })
    ).resolves.toBeUndefined();

    await expect(
        client.notification({
            method: 'notifications/cancelled',
            params: { requestId: 'never-issued-abc', reason: 'unknown string id' }
        })
    ).resolves.toBeUndefined();

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(errors).toEqual([]);

    await expect(client.ping()).resolves.toBeDefined();
});

verifies('typescript:protocol:error:connection-closed', async ({ transport }: TestArgs) => {
    const client = newClient();
    await using _ = await wire(transport, neverRespondingServer, client);

    const onclose = vi.fn();
    client.onclose = onclose;

    const inFlight = [client.listTools(), client.listTools(), client.listTools()];
    for (const p of inFlight) p.catch(() => {});

    await new Promise(resolve => setTimeout(resolve, 50));
    expect(onclose).not.toHaveBeenCalled();

    await client.close();

    for (const p of inFlight) {
        await expect(p).rejects.toBeInstanceOf(SdkError);
        await expect(p).rejects.toMatchObject({ code: SdkErrorCode.ConnectionClosed });
    }
    // onclose fires at least once (transport peers may echo a close back, so don't pin the count).
    await vi.waitFor(() => expect(onclose).toHaveBeenCalled());
});

verifies('protocol:error:internal-error', async ({ transport }: TestArgs) => {
    // Uses raw Server so the throw reaches the protocol layer; McpServer.registerTool
    // catches handler exceptions and wraps as {isError:true} (covered in tools.ts).
    const makeServer = () => {
        const s = new Server({ name: 's', version: '0' }, { capabilities: { tools: {} } });
        s.setRequestHandler('tools/list', () => ({ tools: [] }));
        s.setRequestHandler('tools/call', () => {
            throw new Error('handler exploded');
        });
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const call = client.callTool({ name: 'any', arguments: {} });

    await expect(call).rejects.toBeInstanceOf(ProtocolError);
    await expect(call).rejects.toMatchObject({ code: ProtocolErrorCode.InternalError });
    await expect(call).rejects.toThrow(/handler exploded/);
    expect(ProtocolErrorCode.InternalError).toBe(-32_603);
});

verifies('protocol:error:invalid-params', async ({ transport }: TestArgs) => {
    // Raw Server: setRequestHandler parses the inbound request against
    // CallToolRequestSchema; missing the required `name` field should yield
    // -32602 InvalidParams at the protocol layer (not McpServer's tool-arg validation).
    const makeServer = () => {
        const s = new Server({ name: 's', version: '0' }, { capabilities: { tools: {} } });
        s.setRequestHandler('tools/list', () => ({ tools: [] }));
        s.setRequestHandler('tools/call', () => ({ content: [] }));
        return s;
    };
    const client = newClient();
    // strictValidation off so the malformed request reaches the server instead of being rejected by the wire sniffer.
    await using _ = await wire(transport, makeServer, client, { strictValidation: false });

    const outbound = tapOutbound(client);

    // Send tools/call without the required `name` field.
    const call = client.request({ method: 'tools/call', params: { arguments: {} } }, z.object({}).passthrough());

    await expect(call).rejects.toBeInstanceOf(ProtocolError);

    // The malformed request did reach the wire (failure is server-side, not client-side validation).
    // toMatchObject: on a 2026-07-28 connection the client auto-attaches the per-request `_meta`
    // envelope, which is additive and not part of the assertion's intent.
    const sent = outbound.filter(m => isRequest(m)).find(m => m.method === 'tools/call');
    expect(sent?.params).toMatchObject({ arguments: {} });
    expect((sent?.params as { name?: unknown }).name).toBeUndefined();

    expect(ProtocolErrorCode.InvalidParams).toBe(-32_602);
    await expect(call).rejects.toMatchObject({ code: ProtocolErrorCode.InvalidParams });
});

verifies('protocol:error:method-not-found', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client, { allowCustomMethods: true });

    const outbound = tapOutbound(client);

    const call = client.request({ method: 'no/such/method' }, z.object({}));

    await expect(call).rejects.toBeInstanceOf(ProtocolError);
    await expect(call).rejects.toMatchObject({ code: ProtocolErrorCode.MethodNotFound });
    expect(ProtocolErrorCode.MethodNotFound).toBe(-32_601);

    const sent = outbound.filter(m => 'method' in m && m.method === 'no/such/method' && 'id' in m);
    expect(sent).toHaveLength(1);
});

verifies('protocol:error:reconnect-no-stale-timers', async (_: TestArgs) => {
    // Manages its own connection lifecycle (close + reconnect of the same Client),
    // so it wires inMemory pairs directly instead of using wire(). Transport-agnostic
    // behavior — lives in shared/protocol.ts.
    const serverA = neverRespondingServer();
    const [clientTxA, serverTxA] = InMemoryTransport.createLinkedPair();

    const client = newClient();
    const clientErrors: Error[] = [];
    client.onerror = e => clientErrors.push(e);

    await serverA.connect(serverTxA);
    await client.connect(clientTxA);

    // Park a request with a timeout long enough that we can drop the connection
    // first: its timer is armed in Protocol._timeoutInfo and must be cleared by
    // _onclose(), not left to fire after reconnect.
    const sentOnA: JSONRPCMessage[] = [];
    const origSendA = clientTxA.send.bind(clientTxA);
    clientTxA.send = async (m, opts) => {
        sentOnA.push(m);
        return origSendA(m, opts);
    };
    const inFlight = client.listTools(undefined, { timeout: 400 });
    inFlight.catch(() => {});

    await vi.waitFor(() => expect(sentOnA.filter(m => isRequest(m)).some(m => m.method === 'tools/list')).toBe(true));

    // Connection drops before the 400 ms timeout fires; the in-flight request is
    // rejected by close (how it rejects is protocol:error:connection-closed's concern).
    await clientTxA.close();
    await serverA.close();

    // Reconnect the SAME Client instance to a fresh, healthy server. Tap the new
    // transport before connect so any spurious message would be captured.
    const serverB = new Server({ name: 's-b', version: '0' }, { capabilities: {} });
    const [clientTxB, serverTxB] = InMemoryTransport.createLinkedPair();
    const sentOnB: JSONRPCMessage[] = [];
    const origSendB = clientTxB.send.bind(clientTxB);
    clientTxB.send = async (m, opts) => {
        sentOnB.push(m);
        return origSendB(m, opts);
    };
    await serverB.connect(serverTxB);
    await client.connect(clientTxB);

    // Let the original 400 ms window elapse well past its deadline. A stale timer
    // surviving _onclose() would now fire and push notifications/cancelled (for a
    // request id server B never saw) onto the new transport.
    await new Promise(resolve => setTimeout(resolve, 550));

    expect(sentOnB.filter(m => isNotification(m)).filter(m => m.method === 'notifications/cancelled')).toEqual([]);
    expect(clientErrors).toEqual([]);

    // The reconnected session is healthy.
    await expect(client.ping()).resolves.toBeDefined();
    expect(sentOnB.filter(m => isRequest(m)).some(m => m.method === 'ping')).toBe(true);

    await client.close();
    await serverB.close();
});

verifies('protocol:progress:callback', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('progress', { inputSchema: z.object({ steps: z.number().int().positive() }) }, async ({ steps }, ctx) => {
            const token = ctx.mcpReq._meta?.progressToken;
            if (token !== undefined) {
                for (let i = 1; i <= steps; i++) {
                    await ctx.mcpReq.notify({
                        method: 'notifications/progress',
                        params: {
                            progressToken: token,
                            progress: i,
                            total: steps,
                            message: `step ${i}/${steps}`
                        }
                    });
                }
            }
            return { content: [{ type: 'text', text: `done after ${steps} steps` }] };
        });
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const updates: Progress[] = [];

    await client.callTool(
        { name: 'progress', arguments: { steps: 2 } },
        {
            onprogress: p => updates.push(p)
        }
    );

    expect(updates).toHaveLength(2);

    expect(updates[0]).toMatchObject({ progress: 1, total: 2, message: 'step 1/2' });
    expect(updates[1]).toMatchObject({ progress: 2, total: 2, message: 'step 2/2' });

    expect(updates[0]).not.toHaveProperty('progressToken');
});

verifies('typescript:protocol:progress:token-injected', async ({ transport }: TestArgs) => {
    const received: CallToolRequest['params'][] = [];
    const makeServer = () => {
        const s = new Server({ name: 's', version: '0' }, { capabilities: { tools: {} } });
        s.setRequestHandler('tools/list', () => ({ tools: [] }));
        s.setRequestHandler('tools/call', async (req, ctx) => {
            received.push(req.params);
            const token = req.params._meta?.progressToken;
            if (token !== undefined) {
                await ctx.mcpReq.notify({
                    method: 'notifications/progress',
                    params: { progressToken: token, progress: 1, total: 1 }
                });
            }
            return { content: [{ type: 'text', text: 'ok' }] };
        });
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const traceKey = 'example.com/trace-id';
    const traceId = 'trace-abc-123';
    const progressEvents: Progress[] = [];

    const result = await client.callTool(
        { name: 'any', arguments: {}, _meta: { [traceKey]: traceId } },
        {
            onprogress: p => progressEvents.push(p)
        }
    );

    expect(result.isError).toBeFalsy();
    expect(progressEvents).toEqual([expect.objectContaining({ progress: 1, total: 1 })]);

    expect(received).toHaveLength(1);
    const meta = received[0]?._meta;
    expect(meta?.progressToken).toBeDefined();
    expect(['number', 'string']).toContain(typeof meta?.progressToken);
    // Existing _meta fields are preserved alongside the injected token.
    expect(meta?.[traceKey]).toBe(traceId);
});

verifies('protocol:progress:token-unique', async ({ transport }: TestArgs) => {
    const tokens: Array<string | number> = [];
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('probe', { inputSchema: z.object({}) }, async (_a, ctx) => {
            const token = ctx.mcpReq._meta?.progressToken;
            if (token !== undefined) {
                tokens.push(token);
                await ctx.mcpReq.notify({
                    method: 'notifications/progress',
                    params: { progressToken: token, progress: 1, total: 1 }
                });
            }
            return { content: [] };
        });
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const a = client.callTool({ name: 'probe', arguments: {} }, { onprogress: () => {} });
    const b = client.callTool({ name: 'probe', arguments: {} }, { onprogress: () => {} });

    await Promise.all([a, b]);

    expect(tokens).toHaveLength(2);
    expect(tokens[0]).not.toBe(tokens[1]);
});

verifies('protocol:timeout:basic', async ({ transport }: TestArgs) => {
    vi.useFakeTimers();
    try {
        const client = newClient();
        await using _ = await wire(transport, neverRespondingServer, client);

        const outbound = tapOutbound(client);

        let outcome: { kind: 'resolved' | 'rejected'; value: unknown } | undefined;
        const pending = client.listTools(undefined, { timeout: 100 });
        void pending.then(
            v => (outcome = { kind: 'resolved', value: v }),
            (error: unknown) => (outcome = { kind: 'rejected', value: error })
        );

        await vi.advanceTimersByTimeAsync(0);
        expect(outbound.filter(m => isRequest(m)).some(m => m.method === 'tools/list')).toBe(true);
        expect(outcome).toBeUndefined();

        await vi.advanceTimersByTimeAsync(99);
        expect(outcome).toBeUndefined();

        await vi.advanceTimersByTimeAsync(2);
        expect(outcome?.kind).toBe('rejected');
        expect(outcome?.value).toBeInstanceOf(SdkError);
        expect(outcome?.value).toMatchObject({ code: SdkErrorCode.RequestTimeout });
    } finally {
        vi.useRealTimers();
    }
});

verifies('protocol:timeout:max-total', async ({ transport }: TestArgs) => {
    vi.useFakeTimers();
    try {
        const makeServer = () => {
            const s = new McpServer({ name: 's', version: '0' });
            s.registerTool(
                'slow-progress',
                { inputSchema: z.object({ delayMs: z.number(), steps: z.number() }) },
                async ({ delayMs, steps }, ctx) => {
                    const token = ctx.mcpReq._meta?.progressToken;
                    if (token !== undefined) {
                        for (let i = 1; i <= steps; i++) {
                            await new Promise(resolve => setTimeout(resolve, delayMs));
                            await ctx.mcpReq.notify({
                                method: 'notifications/progress',
                                params: { progressToken: token, progress: i, total: steps }
                            });
                        }
                    }
                    return { content: [] };
                }
            );
            return s;
        };
        const client = newClient();
        await using _ = await wire(transport, makeServer, client);

        const perChunk = 500;
        const maxTotal = 1000;
        const delayMs = 200;

        const ticks: number[] = [];

        const call = client.callTool(
            { name: 'slow-progress', arguments: { delayMs, steps: 100 } },
            {
                timeout: perChunk,
                resetTimeoutOnProgress: true,
                maxTotalTimeout: maxTotal,
                onprogress: p => ticks.push(p.progress)
            }
        );
        call.catch(() => {});

        for (let elapsed = 0; elapsed < maxTotal + perChunk; elapsed += delayMs) {
            await vi.advanceTimersByTimeAsync(delayMs);
        }

        await expect(call).rejects.toBeInstanceOf(SdkError);
        await expect(call).rejects.toMatchObject({ code: SdkErrorCode.RequestTimeout });

        expect(ticks.length).toBeGreaterThanOrEqual(3);
    } finally {
        vi.useRealTimers();
    }
});

verifies('protocol:timeout:reset-on-progress', async ({ transport }: TestArgs) => {
    vi.useFakeTimers();
    try {
        const makeServer = () => {
            const s = new McpServer({ name: 's', version: '0' });
            s.registerTool(
                'slow-progress',
                { inputSchema: z.object({ steps: z.number(), delayMs: z.number() }) },
                async ({ steps, delayMs }, ctx) => {
                    const token = ctx.mcpReq._meta?.progressToken;
                    if (token !== undefined) {
                        for (let i = 1; i <= steps; i++) {
                            await new Promise(resolve => setTimeout(resolve, delayMs));
                            await ctx.mcpReq.notify({
                                method: 'notifications/progress',
                                params: { progressToken: token, progress: i, total: steps }
                            });
                        }
                    }
                    return { content: [{ type: 'text', text: `done after ${steps} steps` }] };
                }
            );
            return s;
        };
        const client = newClient();
        await using _ = await wire(transport, makeServer, client);

        const timeout = 200;
        const steps = 3;
        const delayMs = 150;

        const received: number[] = [];
        let settled: 'resolved' | 'rejected' | undefined;

        const call = client
            .callTool(
                { name: 'slow-progress', arguments: { steps, delayMs } },
                {
                    timeout,
                    resetTimeoutOnProgress: true,
                    onprogress: p => {
                        received.push(p.progress);
                    }
                }
            )
            .then(
                r => ((settled = 'resolved'), r),
                error => ((settled = 'rejected'), Promise.reject(error))
            );

        for (let i = 1; i <= steps; i++) {
            await vi.advanceTimersByTimeAsync(delayMs);
            await vi.waitFor(() => expect(received.length).toBeGreaterThanOrEqual(i));
            if (i < steps) expect(settled).toBeUndefined();
        }

        const result = await call;

        expect(settled).toBe('resolved');
        expect(received).toEqual([1, 2, 3]);
        expect(result.isError).toBeFalsy();
        expect(result.content).toEqual([{ type: 'text', text: `done after ${steps} steps` }]);
    } finally {
        vi.useRealTimers();
    }
});

verifies('protocol:timeout:sends-cancellation', async ({ transport }: TestArgs) => {
    vi.useFakeTimers();
    try {
        const client = newClient();
        await using _ = await wire(transport, neverRespondingServer, client);

        const outbound = tapOutbound(client);

        const pending = client.listTools(undefined, { timeout: 100 });
        // Snapshot at rejection time so the cancellation-before-reject ordering is actually observed.
        let sentAtRejection: JSONRPCMessage[] | undefined;
        pending.catch(() => {
            sentAtRejection = [...outbound];
        });

        await vi.advanceTimersByTimeAsync(100);

        await expect(pending).rejects.toBeInstanceOf(SdkError);
        await expect(pending).rejects.toMatchObject({ code: SdkErrorCode.RequestTimeout });

        expect(sentAtRejection).toBeDefined();
        if (!sentAtRejection) throw new Error('rejection snapshot not captured');
        const listReq = sentAtRejection.filter(m => isRequest(m)).find(m => m.method === 'tools/list');
        expect(listReq).toBeDefined();

        const cancelled = sentAtRejection.filter(m => isNotification(m)).find(m => m.method === 'notifications/cancelled');
        expect(cancelled, 'notifications/cancelled must be handed to transport.send() before the request promise rejects').toBeDefined();
        if (!listReq || !cancelled) throw new Error('expected tools/list request and notifications/cancelled on the wire');
        expect(cancelled.params?.requestId).toBe(listReq.id);
        expect(String(cancelled.params?.reason)).toMatch(/timed? ?out/i);
        expect(sentAtRejection.indexOf(cancelled)).toBeGreaterThan(sentAtRejection.indexOf(listReq));
    } finally {
        vi.useRealTimers();
    }
});

verifies(
    'mcpserver:onerror:reach-through',
    async ({ transport }: TestArgs) => {
        const errors: Error[] = [];
        const makeServer = () => {
            const s = new McpServer({ name: 's', version: '0' });
            s.server.onerror = e => errors.push(e);
            return s;
        };
        const client = newClient();
        await using _ = await wire(transport, makeServer, client, { strictValidation: false });

        const baseA = errors.length;
        const stray: JSONRPCMessage = { jsonrpc: '2.0', id: 99_999, result: {} };
        await client.transport?.send(stray);

        await vi.waitFor(() => errors.length > baseA);

        const hitA = errors.slice(baseA).find(e => /unknown message ID/i.test(e.message));
        expect(
            hitA,
            `expected an "unknown message ID" onerror; got: ${errors
                .slice(baseA)
                .map(e => e.message)
                .join(' | ')}`
        ).toBeDefined();
        expect(hitA?.message).toContain('99999');

        const baseB = errors.length;
        const badProgress: JSONRPCMessage = {
            jsonrpc: '2.0',
            method: 'notifications/progress',
            params: { progressToken: 'onerror-reach-through', progress: 'not-a-number' }
        };
        await client.transport?.send(badProgress);

        await vi.waitFor(() => errors.length > baseB);

        const hitB = errors.slice(baseB).find(e => /uncaught error in notification handler/i.test(e.message));
        expect(
            hitB,
            `expected an "Uncaught error in notification handler" onerror; got: ${errors
                .slice(baseB)
                .map(e => e.message)
                .join(' | ')}`
        ).toBeDefined();

        await expect(client.ping()).resolves.toBeDefined();
    },
    { title: 'via mcpServer.server' }
);

verifies('protocol:custom-method:notification', async ({ transport }: TestArgs) => {
    const HEARTBEAT_METHOD = 'myorg/heartbeat';
    const HeartbeatParamsSchema = z.object({ seq: z.number(), tag: z.string() });

    let server: Server | undefined;
    const makeServer = () => {
        server = new Server({ name: 's', version: '0' }, { capabilities: {} });
        return server;
    };

    const received: Array<{ method: string; params: z.infer<typeof HeartbeatParamsSchema> }> = [];
    const clientErrors: Error[] = [];
    const client = newClient();
    client.onerror = e => clientErrors.push(e);

    await using _ = await wire(transport, makeServer, client, { allowCustomMethods: true });

    client.setNotificationHandler(HEARTBEAT_METHOD, { params: HeartbeatParamsSchema }, (params, notification) => {
        received.push({ method: notification.method, params });
    });

    if (!server) throw new Error('server not created');
    await server.notification({
        method: HEARTBEAT_METHOD,
        params: { seq: 7, tag: 'custom', extra: 'stripped-by-zod' }
    });

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]?.method).toBe(HEARTBEAT_METHOD);
    // Handler receives the schema-parsed params (extra fields stripped).
    expect(received[0]?.params).toEqual({ seq: 7, tag: 'custom' });
    expect(received[0]?.params).not.toHaveProperty('extra');
    expect(clientErrors).toEqual([]);
});

verifies('protocol:error:data-roundtrip', async ({ transport }: TestArgs) => {
    // Raw Server so the McpError reaches the protocol layer's error envelope.
    const data = { detail: 'x', nested: { n: 1 } };
    const makeServer = () => {
        const s = new Server({ name: 's', version: '0' }, { capabilities: { tools: {} } });
        s.setRequestHandler('tools/list', () => ({ tools: [] }));
        s.setRequestHandler('tools/call', () => {
            throw new ProtocolError(ProtocolErrorCode.InternalError, 'boom', data);
        });
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const call = client.callTool({ name: 'any', arguments: {} });

    await expect(call).rejects.toBeInstanceOf(ProtocolError);
    await expect(call).rejects.toThrow(/boom/);
    await expect(call).rejects.toMatchObject({ code: ProtocolErrorCode.InternalError, data });
});

verifies('protocol:fallback-notification-handler', async ({ transport }: TestArgs) => {
    const NEVER_REGISTERED = 'notifications/_e2e/never-registered';

    // Notifications are emitted from inside the tools/call handler so they cross the real wire on every transport, including stateless hosting.
    const makeServer = () => {
        const s = new Server(
            { name: 's', version: '0' },
            { capabilities: { tools: { listChanged: true }, prompts: { listChanged: true } } }
        );
        s.setRequestHandler('tools/list', () => ({ tools: [] }));
        s.setRequestHandler('tools/call', async (_req, ctx) => {
            await ctx.mcpReq.notify({ method: NEVER_REGISTERED });
            await ctx.mcpReq.notify({ method: 'notifications/prompts/list_changed' });
            await ctx.mcpReq.notify({ method: 'notifications/tools/list_changed' });
            return { content: [] };
        });
        return s;
    };
    const client = newClient();

    const fallback: Notification[] = [];
    const specific: Notification[] = [];

    await using _ = await wire(transport, makeServer, client, { allowCustomMethods: true });

    client.setNotificationHandler('notifications/tools/list_changed', async n => {
        specific.push(n);
    });
    client.setNotificationHandler('notifications/prompts/list_changed', async n => {
        specific.push(n);
    });

    client.fallbackNotificationHandler = async n => {
        fallback.push(n);
    };

    client.removeNotificationHandler('notifications/prompts/list_changed');

    await client.callTool({ name: 'emit-notifications', arguments: {} });

    await vi.waitFor(() =>
        expect(
            fallback.some(n => n.method === NEVER_REGISTERED) &&
                fallback.some(n => n.method === 'notifications/prompts/list_changed') &&
                specific.some(n => n.method === 'notifications/tools/list_changed')
        ).toBe(true)
    );

    expect(fallback.filter(n => n.method === NEVER_REGISTERED)).toHaveLength(1);
    expect(specific.filter(n => n.method === NEVER_REGISTERED)).toHaveLength(0);

    expect(fallback.filter(n => n.method === 'notifications/prompts/list_changed')).toHaveLength(1);
    expect(specific.filter(n => n.method === 'notifications/prompts/list_changed')).toHaveLength(0);

    expect(specific.filter(n => n.method === 'notifications/tools/list_changed')).toHaveLength(1);
    expect(fallback.filter(n => n.method === 'notifications/tools/list_changed')).toHaveLength(0);
});

verifies('protocol:handler:re-register-replaces', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('list-roots', { inputSchema: z.object({}) }, async (_a, ctx) => {
            const result = await ctx.mcpReq.send({ method: 'roots/list' }, specTypeSchemas.ListRootsResult);
            return { structuredContent: { ok: true, result }, content: [] };
        });
        return s;
    };
    const client = new Client({ name: 'c', version: '0' }, { capabilities: { roots: { listChanged: true } } });
    await using _ = await wire(transport, makeServer, client);

    let firstCalls = 0;
    let secondCalls = 0;

    client.setRequestHandler('roots/list', async () => {
        firstCalls++;
        return { roots: [{ uri: 'file:///first', name: 'first' }] };
    });

    expect(() =>
        client.setRequestHandler('roots/list', async () => {
            secondCalls++;
            return { roots: [{ uri: 'file:///second', name: 'second' }] };
        })
    ).not.toThrow();

    const result = await client.callTool({ name: 'list-roots', arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
        ok: true,
        result: { roots: [{ uri: 'file:///second', name: 'second' }] }
    });

    expect(secondCalls).toBe(1);
    expect(firstCalls).toBe(0);
});

const X_ECHO_METHOD = 'x-e2e/echo';
const XEchoParamsSchema = z.object({ value: z.string() });
const XEchoResultSchema = z.object({ echoed: z.string() });

function customEchoServer(): Server {
    const s = new Server({ name: 's', version: '0' }, { capabilities: {} });
    s.setRequestHandler(X_ECHO_METHOD, { params: XEchoParamsSchema, result: XEchoResultSchema }, params => ({ echoed: params.value }));
    return s;
}

verifies('protocol:custom-method:request', async ({ transport }: TestArgs) => {
    const client = newClient();
    await using _ = await wire(transport, customEchoServer, client, { allowCustomMethods: true });

    const result = await client.request({ method: X_ECHO_METHOD, params: { value: 'hi' } }, XEchoResultSchema);

    expect(result).toEqual({ echoed: 'hi' });
});

verifies('protocol:custom-method:roundtrip', async ({ transport }: TestArgs) => {
    const client = newClient();
    const clientErrors: Error[] = [];
    client.onerror = e => clientErrors.push(e);
    await using _ = await wire(transport, customEchoServer, client, { allowCustomMethods: true });

    // Custom method dispatches to the user handler — not -32601 MethodNotFound.
    const result = await client.request({ method: X_ECHO_METHOD, params: { value: 'round' } }, XEchoResultSchema);
    expect(result).toEqual({ echoed: 'round' });
    expect(clientErrors).toEqual([]);

    // A truly-unknown method still surfaces as MethodNotFound, proving the
    // custom registration is what made the previous call succeed.
    await expect(client.request({ method: 'x-e2e/never-registered', params: {} }, specTypeSchemas.Result)).rejects.toMatchObject({
        code: ProtocolErrorCode.MethodNotFound
    });
});

verifies('protocol:custom-notification:roundtrip', async ({ transport }: TestArgs) => {
    const X_EVENT_METHOD = 'x-e2e/event';
    const XEventParamsSchema = z.object({ kind: z.string(), id: z.number() });

    const received: Array<{ method: string; params: z.infer<typeof XEventParamsSchema> }> = [];
    const serverErrors: Error[] = [];
    const makeServer = () => {
        const s = new Server({ name: 's', version: '0' }, { capabilities: {} });
        s.onerror = e => serverErrors.push(e);
        s.setNotificationHandler(X_EVENT_METHOD, { params: XEventParamsSchema }, (params, notification) => {
            received.push({ method: notification.method, params });
        });
        return s;
    };

    const client = newClient();
    await using _ = await wire(transport, makeServer, client, { allowCustomMethods: true });

    await client.notification({ method: X_EVENT_METHOD, params: { kind: 'k', id: 42, extra: 'stripped-by-zod' } });

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]?.method).toBe(X_EVENT_METHOD);
    // Handler receives the schema-parsed params (extra fields stripped), not raw passthrough.
    expect(received[0]?.params).toEqual({ kind: 'k', id: 42 });
    expect(received[0]?.params).not.toHaveProperty('extra');
    expect(serverErrors).toEqual([]);
});

verifies('protocol:meta:request-to-handler', async ({ transport }: TestArgs) => {
    const requestMeta = { 'example.com/trace-id': 'trace-abc-123', 'example.com/tenant': { org: 'acme', region: 'eu-west-1' } };
    const handlerParamsMeta: unknown[] = [];
    const handlerExtraMeta: unknown[] = [];
    const makeServer = () => {
        const s = new Server({ name: 's', version: '0' }, { capabilities: { tools: {} } });
        s.setRequestHandler('tools/list', () => ({ tools: [] }));
        s.setRequestHandler('tools/call', (req, ctx) => {
            handlerParamsMeta.push(req.params._meta);
            handlerExtraMeta.push(ctx.mcpReq._meta);
            return { content: [{ type: 'text', text: 'traced' }] };
        });
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const result = await client.callTool({ name: 'traced_call', arguments: {}, _meta: requestMeta });

    expect(result.content).toEqual([{ type: 'text', text: 'traced' }]);
    // Exact equality against the sent object: nothing was stripped and nothing (e.g. a progressToken) was injected.
    expect(handlerParamsMeta).toEqual([requestMeta]);
    expect(handlerExtraMeta).toEqual([requestMeta]);
});

verifies('protocol:meta:result-to-client', async ({ transport }: TestArgs) => {
    const resultMeta = { 'example.com/cost-tokens': 42, 'example.com/cache': { hit: true, region: 'eu-west-1' } };
    const makeServer = () => {
        const s = new Server({ name: 's', version: '0' }, { capabilities: { tools: {} } });
        s.setRequestHandler('tools/list', () => ({ tools: [] }));
        s.setRequestHandler('tools/call', () => ({ content: [{ type: 'text', text: 'metered' }], _meta: resultMeta }));
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const result = await client.callTool({ name: 'metered_call', arguments: {} });

    expect(result.content).toEqual([{ type: 'text', text: 'metered' }]);
    // The _meta the handler attached to its result reaches the requesting client unchanged.
    expect(result._meta).toEqual(resultMeta);
});

verifies('protocol:request-id:unique', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('echo', { inputSchema: z.object({ text: z.string() }) }, ({ text }) => ({
            content: [{ type: 'text', text }]
        }));
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const tap = tapWire(client);

    await client.ping();
    await client.listTools();
    await Promise.all([
        client.callTool({ name: 'echo', arguments: { text: 'first' } }),
        client.callTool({ name: 'echo', arguments: { text: 'second' } })
    ]);
    await client.ping();

    const requests = tap.sent.filter(m => isRequest(m));
    expect(requests.map(m => m.method).toSorted()).toEqual(['ping', 'ping', 'tools/call', 'tools/call', 'tools/list']);

    const ids = requests.map(m => m.id);
    for (const id of ids) {
        expect(id).not.toBeNull();
        expect(['string', 'number']).toContain(typeof id);
    }
    // Five requests on the session, five distinct ids — no id is ever reused.
    expect(new Set(ids).size).toBe(5);
});

verifies('protocol:notifications:no-response', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('echo', { inputSchema: z.object({ text: z.string() }) }, ({ text }) => ({
            content: [{ type: 'text', text }]
        }));
        return s;
    };
    const client = new Client({ name: 'c', version: '0' }, { capabilities: { roots: { listChanged: true } } });
    await using _ = await wire(transport, makeServer, client);

    const tap = tapWire(client);

    await client.sendRootsListChanged();
    await client.notification({
        method: 'notifications/cancelled',
        params: { requestId: 424_242, reason: 'request was never issued' }
    });

    const result = await client.callTool({ name: 'echo', arguments: { text: 'after notifications' } });
    expect(result.content).toEqual([{ type: 'text', text: 'after notifications' }]);
    await expect(client.ping()).resolves.toBeDefined();

    // Both requests round-tripped after the notifications, so a (non-conformant) reply to either notification would have arrived by now.
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(tap.sent.filter(m => isNotification(m)).map(m => m.method)).toEqual([
        'notifications/roots/list_changed',
        'notifications/cancelled'
    ]);
    const requestIds = tap.sent.filter(m => isRequest(m)).map(m => m.id);
    expect(requestIds).toHaveLength(2);

    const responses = tap.received.filter(m => isResponse(m));
    expect(responses.map(m => m.id)).toEqual(requestIds);
    for (const m of tap.received) {
        if (isResponse(m)) {
            expect(requestIds).toContain(m.id);
        } else {
            // Anything that is not a response to one of our requests must be an id-less notification.
            expect(isNotification(m), `unexpected server→client message: ${JSON.stringify(m)}`).toBe(true);
        }
    }
});

verifies('protocol:progress:monotonic', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('index_files', { inputSchema: z.object({}) }, async (_a, ctx) => {
            const token = ctx.mcpReq._meta?.progressToken;
            if (token === undefined) throw new Error('expected a progressToken on the request');
            await ctx.mcpReq.notify({
                method: 'notifications/progress',
                params: { progressToken: token, progress: 5, message: 'indexed 5 files' }
            });
            try {
                // A spec-compliant sender refuses (or drops) this regression to a smaller value.
                await ctx.mcpReq.notify({
                    method: 'notifications/progress',
                    params: { progressToken: token, progress: 3, message: 'regressed' }
                });
            } catch {
                /* sender-side rejection of the non-increasing value is a valid way to satisfy the spec */
            }
            await ctx.mcpReq.notify({
                method: 'notifications/progress',
                params: { progressToken: token, progress: 12, message: 'indexed 12 files' }
            });
            return { content: [{ type: 'text', text: 'indexing complete' }] };
        });
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const updates: Progress[] = [];
    const result = await client.callTool({ name: 'index_files', arguments: {} }, { onprogress: p => updates.push(p) });

    expect(result.content).toEqual([{ type: 'text', text: 'indexing complete' }]);

    // Progress flows even though no total was supplied.
    expect(updates.map(p => p.progress)).toContain(5);
    expect(updates.map(p => p.progress)).toContain(12);
    for (const update of updates) {
        expect(update.total).toBeUndefined();
    }
    // Spec: the progress value MUST increase with each notification for the token, so the regressed value never reaches the caller.
    for (let i = 1; i < updates.length; i++) {
        const previous = updates[i - 1];
        const current = updates[i];
        if (!previous || !current) throw new Error('progress updates list changed during iteration');
        expect(
            current.progress,
            `progress sequence ${updates.map(p => p.progress).join(' → ')} must be strictly increasing`
        ).toBeGreaterThan(previous.progress);
    }
});

verifies('protocol:progress:stops-after-completion', async ({ transport }: TestArgs) => {
    let server: Server | undefined;
    let lateProgress: (() => Promise<void>) | undefined;
    const makeServer = () => {
        const s = new Server({ name: 's', version: '0' }, { capabilities: { tools: { listChanged: true } } });
        server = s;
        s.setRequestHandler('tools/list', () => ({ tools: [] }));
        s.setRequestHandler('tools/call', async (req, ctx) => {
            const token = req.params._meta?.progressToken;
            if (token === undefined) throw new Error('expected a progressToken on the request');
            await ctx.mcpReq.notify({
                method: 'notifications/progress',
                params: { progressToken: token, progress: 1, total: 2, message: 'halfway' }
            });
            // Captured so the test can attempt a post-completion progress send for the same token through the public API.
            lateProgress = () =>
                s.notification({
                    method: 'notifications/progress',
                    params: { progressToken: token, progress: 2, total: 2, message: 'late' }
                });
            return { content: [{ type: 'text', text: 'partial upload complete' }] };
        });
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const tap = tapWire(client);

    const updates: Progress[] = [];
    const result = await client.callTool({ name: 'upload', arguments: {} }, { onprogress: p => updates.push(p) });

    expect(result.content).toEqual([{ type: 'text', text: 'partial upload complete' }]);
    expect(updates).toEqual([{ progress: 1, total: 2, message: 'halfway' }]);

    const receivedBeforeLateSend = tap.received.length;
    if (!lateProgress) throw new Error('handler did not capture the late-progress sender');
    await lateProgress();
    // Sentinel on the same server→client channel: once it arrives, the late progress (had it been sent) would have arrived too.
    if (!server) throw new Error('server not created');
    await server.sendToolListChanged();
    await vi.waitFor(() =>
        expect(tap.received.filter(m => isNotification(m)).filter(m => m.method === 'notifications/tools/list_changed')).toHaveLength(1)
    );

    // Spec: progress notifications for the token stop once the associated request has completed.
    const lateProgressOnWire = tap.received
        .slice(receivedBeforeLateSend)
        .filter(m => isNotification(m))
        .filter(m => m.method === 'notifications/progress');
    expect(lateProgressOnWire).toEqual([]);
});

verifies('protocol:cancel:in-flight', async ({ transport }: TestArgs) => {
    const handlerStarted: RequestId[] = [];
    const handlerAbortReasons: unknown[] = [];
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool(
            'long_export',
            { inputSchema: z.object({}) },
            async (_a, ctx) =>
                new Promise((_resolve, reject) => {
                    handlerStarted.push(ctx.mcpReq.id);
                    ctx.mcpReq.signal.addEventListener('abort', () => {
                        handlerAbortReasons.push(ctx.mcpReq.signal.reason);
                        reject(new Error(String(ctx.mcpReq.signal.reason)));
                    });
                })
        );
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const tap = tapWire(client);

    const ac = new AbortController();
    const call = client.callTool({ name: 'long_export', arguments: {} }, { signal: ac.signal });
    call.catch(() => {});

    // Cancel only once the handler is running, so the cancellation targets a request that is genuinely in flight on the server.
    await vi.waitFor(() => expect(handlerStarted).toHaveLength(1));
    const callRequest = tap.sent.filter(m => isRequest(m)).find(m => m.method === 'tools/call');
    if (!callRequest) throw new Error('tools/call request not captured');

    ac.abort(new Error('user cancelled the export'));
    await expect(call).rejects.toThrow('user cancelled the export');

    await vi.waitFor(() =>
        expect(
            tap.sent
                .filter(m => isNotification(m))
                .filter(m => m.method === 'notifications/cancelled')
                .map(m => m.params?.requestId)
        ).toEqual([callRequest.id])
    );

    // The cancellation stopped the server-side handler, carrying the client's reason.
    await vi.waitFor(() => expect(handlerAbortReasons).toHaveLength(1));
    expect(String(handlerAbortReasons[0])).toContain('user cancelled the export');

    // A later round-trip on the same channel proves a (non-conformant) response to the cancelled request would have arrived by now.
    await expect(client.ping()).resolves.toBeDefined();
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(tap.received.filter(m => isResponse(m)).filter(m => m.id === callRequest.id)).toEqual([]);
});

verifies('protocol:progress:client-to-server', async ({ transport }: TestArgs) => {
    const serverUpdates: Progress[] = [];
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('summarize_report', { inputSchema: z.object({ text: z.string() }) }, async ({ text }, ctx) => {
            const result = await ctx.mcpReq.send(
                {
                    method: 'sampling/createMessage',
                    params: {
                        messages: [{ role: 'user', content: { type: 'text', text: `Summarize the following report:\n${text}` } }],
                        maxTokens: 200
                    }
                },
                specTypeSchemas.CreateMessageResult,
                { onprogress: p => serverUpdates.push(p) }
            );
            if (result.content.type !== 'text') throw new Error('expected text sampling content');
            return { content: [{ type: 'text', text: result.content.text }] };
        });
        return s;
    };

    const client = new Client({ name: 'c', version: '0' }, { capabilities: { sampling: {} } });
    client.setRequestHandler('sampling/createMessage', async (req, ctx) => {
        const token = req.params._meta?.progressToken;
        if (token === undefined) throw new Error('expected a progressToken on the sampling request');
        await ctx.mcpReq.notify({
            method: 'notifications/progress',
            params: { progressToken: token, progress: 1, total: 2, message: 'sampling started' }
        });
        await ctx.mcpReq.notify({
            method: 'notifications/progress',
            params: { progressToken: token, progress: 2, total: 2, message: 'sampling finished' }
        });
        return {
            model: 'test-model',
            role: 'assistant',
            stopReason: 'endTurn',
            content: { type: 'text', text: 'Quarterly revenue grew 12%.' }
        };
    });

    await using _ = await wire(transport, makeServer, client);

    const result = await client.callTool({
        name: 'summarize_report',
        arguments: { text: 'Revenue was up 12% quarter over quarter, driven by enterprise renewals.' }
    });

    expect(result.content).toEqual([{ type: 'text', text: 'Quarterly revenue grew 12%.' }]);

    await vi.waitFor(() => expect(serverUpdates).toHaveLength(2));
    expect(serverUpdates).toEqual([
        { progress: 1, total: 2, message: 'sampling started' },
        { progress: 2, total: 2, message: 'sampling finished' }
    ]);
});

verifies('protocol:request-handler:override-builtin', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new Server({ name: 's', version: '0' }, { capabilities: {} });
        // Ping has a built-in handler; this should replace it without throwing.
        s.setRequestHandler('ping', () => ({ _meta: { 'e2e/overridden': true } }));
        return s;
    };

    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    expect(() => new Server({ name: 's', version: '0' }, { capabilities: {} }).setRequestHandler('ping', () => ({}))).not.toThrow();

    const result = await client.ping();
    expect(result).toEqual({ _meta: { 'e2e/overridden': true } });
});

verifies(
    'mcpserver:onerror:reach-through',
    async ({ transport }: TestArgs) => {
        const errors: Error[] = [];
        const makeServer = () => {
            const s = new Server({ name: 's', version: '0' }, { capabilities: {} });
            s.onerror = e => errors.push(e);
            return s;
        };
        const client = newClient();
        await using _ = await wire(transport, makeServer, client);

        const baseA = errors.length;
        const stray: JSONRPCMessage = { jsonrpc: '2.0', id: 99_999, result: {} };
        await client.transport?.send(stray);

        await vi.waitFor(() => expect(errors.length).toBeGreaterThan(baseA));

        const hitA = errors.slice(baseA).find(e => /unknown message ID/i.test(e.message));
        expect(
            hitA,
            `expected an "unknown message ID" onerror; got: ${errors
                .slice(baseA)
                .map(e => e.message)
                .join(' | ')}`
        ).toBeDefined();
        expect(hitA?.message).toContain('99999');

        await expect(client.ping()).resolves.toBeDefined();
    },
    { title: 'raw Server' }
);

verifies('typescript:method-string-handlers:result-type-inference', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('echo', { description: 'echoes text', inputSchema: z.object({ text: z.string() }) }, ({ text }) => ({
            content: [{ type: 'text', text }]
        }));
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    // Spec method string, no result schema: the result arrives parsed as ListToolsResult via ResultTypeMap inference.
    const viaRequest = await client.request({ method: 'tools/list', params: {} });

    // .tools is usable directly — no schema argument and no casts anywhere is the type-inference proof.
    expect(viaRequest.tools.map(t => t.name)).toEqual(['echo']);
    expect(viaRequest.tools[0]?.description).toBe('echoes text');

    // The schema-less request agrees with the dedicated typed method for the same call.
    const viaListTools = await client.listTools();
    expect(viaRequest.tools).toEqual(viaListTools.tools);

    // Another spec method, again schema-less: ping resolves with its parsed (empty) result.
    await expect(client.request({ method: 'ping' })).resolves.toEqual({});
});

verifies('protocol:result-validation:invalid-result-sdkerror', async ({ transport }: TestArgs) => {
    const WRONG_SHAPE_METHOD = 'x-e2e/wrong-shape';
    // Handler declares no result schema, so it can legally return a shape the requesting side's schema rejects.
    const makeServer = () => {
        const s = new Server({ name: 's', version: '0' }, { capabilities: {} });
        s.setRequestHandler(WRONG_SHAPE_METHOD, { params: z.object({}) }, () => ({ wrong: true }));
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client, { allowCustomMethods: true });

    const call = client.request({ method: WRONG_SHAPE_METHOD, params: {} }, z.object({ right: z.string() }));

    // The non-conforming result rejects as SdkError InvalidResult — never resolves, and no raw validation error leaks.
    await expect(call).rejects.toBeInstanceOf(SdkError);
    await expect(call).rejects.toMatchObject({ code: SdkErrorCode.InvalidResult });
    await expect(call).rejects.toThrow(/Invalid result for x-e2e\/wrong-shape/);
});

verifies('typescript:protocol:error:not-connected', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('summarize_document', { inputSchema: z.object({ text: z.string() }) }, ({ text }) => ({
            content: [{ type: 'text', text: `summary: ${text}` }]
        }));
        return s;
    };

    // Never-connected client: no transport yet, and request methods reject immediately.
    const client = newClient();
    expect(client.transport).toBeUndefined();
    const beforeConnect = client.listTools();
    await expect(beforeConnect).rejects.toBeInstanceOf(Error);
    await expect(beforeConnect).rejects.toMatchObject({ message: 'Not connected' });

    // Once connected over the matrix transport, the same client serves requests normally.
    await using _ = await wire(transport, makeServer, client);
    expect(client.transport).toBeDefined();
    const listed = await client.listTools();
    expect(listed.tools.map(t => t.name)).toEqual(['summarize_document']);
    const result = await client.callTool({ name: 'summarize_document', arguments: { text: 'Q3 sales were flat.' } });
    expect(result.content).toEqual([{ type: 'text', text: 'summary: Q3 sales were flat.' }]);

    // Closed-state checks use a direct InMemory pair: the in-process stdio harness never fires the client transport's onclose.
    const closedClient = newClient();
    const closedServer = makeServer();
    const [closedClientTx, closedServerTx] = InMemoryTransport.createLinkedPair();
    try {
        await closedServer.connect(closedServerTx);
        await closedClient.connect(closedClientTx);
        expect(closedClient.transport).toBe(closedClientTx);

        await closedClient.close();

        expect(closedClient.transport).toBeUndefined();
        const afterClose = closedClient.listTools();
        await expect(afterClose).rejects.toBeInstanceOf(Error);
        await expect(afterClose).rejects.toMatchObject({ message: 'Not connected' });
    } finally {
        await closedClient.close();
        await closedServer.close();
    }
});

/** Consumer-implemented Transport: an in-process loopback that answers initialize and tools/list with canned results. */
class LoopbackTransport implements Transport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;

    readonly events: string[] = [];
    readonly clientRequests: JSONRPCRequest[] = [];
    callbacksPresentAtStart?: { onmessage: boolean; onclose: boolean; onerror: boolean };

    constructor(private readonly serverProtocolVersion: string) {}

    async start(): Promise<void> {
        this.callbacksPresentAtStart = {
            onmessage: this.onmessage !== undefined,
            onclose: this.onclose !== undefined,
            onerror: this.onerror !== undefined
        };
        this.events.push('start');
    }

    async send(message: JSONRPCMessage): Promise<void> {
        this.events.push('method' in message ? `send:${message.method}` : 'send:response');
        if (!isRequest(message)) return;
        this.clientRequests.push(message);
        const modern = this.serverProtocolVersion >= '2026-07-28';
        switch (message.method) {
            case 'initialize': {
                this.respond(message.id, {
                    protocolVersion: this.serverProtocolVersion,
                    capabilities: { tools: {} },
                    serverInfo: { name: 'loopback-server', version: '3.1.4' }
                });
                break;
            }
            case 'server/discover': {
                // The 2026-era handshake: advertise the canned identity instead of
                // answering an initialize exchange.
                this.respond(message.id, {
                    supportedVersions: [this.serverProtocolVersion],
                    capabilities: { tools: {} },
                    serverInfo: { name: 'loopback-server', version: '3.1.4' }
                });
                break;
            }
            case 'tools/list': {
                const tools = [{ name: 'lookup_order', description: 'Look up an order by id', inputSchema: { type: 'object' } }];
                this.respond(
                    message.id,
                    modern
                        ? // The 2026 wire shape carries the result discriminator and the cacheable-result fields.
                          ({ resultType: 'complete', ttlMs: 0, cacheScope: 'public', tools } as unknown as Result)
                        : { tools }
                );
                break;
            }
            default: {
                break;
            }
        }
    }

    async close(): Promise<void> {
        this.events.push('close');
        this.onclose?.();
    }

    private respond(id: RequestId, result: Result): void {
        queueMicrotask(() => this.onmessage?.({ jsonrpc: '2.0', id, result }));
    }
}

verifies('transport:custom:client-connect', async ({ protocolVersion }: TestArgs) => {
    // The body supplies its own consumer-implemented Transport, so the matrix transport arg is unused by design.
    // On 2025-era cells the handshake is the plain initialize exchange; on 2026-era cells it is the
    // server/discover negotiation (a 2026 revision is never negotiated via initialize), which the client opts
    // into by pinning the cell's revision.
    const modern = protocolVersion >= '2026-07-28';
    const customTransport = new LoopbackTransport(protocolVersion);
    const client = modern
        ? new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: { pin: protocolVersion } } })
        : newClient();
    const clientOnclose = vi.fn();
    client.onclose = clientOnclose;
    const handshake = modern ? ['send:server/discover'] : ['send:initialize', 'send:notifications/initialized'];
    const handshakeRequests = modern ? ['server/discover'] : ['initialize'];
    try {
        await client.connect(customTransport);

        // Connect installed callbacks on the consumer object before invoking start().
        expect(customTransport.callbacksPresentAtStart).toEqual({ onmessage: true, onclose: true, onerror: true });
        // The full handshake ran over the consumer transport, and its canned identity is what the client now reports.
        expect(customTransport.events).toEqual(['start', ...handshake]);
        expect(client.getServerCapabilities()).toEqual({ tools: {} });
        expect(client.getServerVersion()).toEqual({ name: 'loopback-server', version: '3.1.4' });
        expect(client.getNegotiatedProtocolVersion()).toBe(protocolVersion);

        // A post-handshake request round-trips through the consumer transport's send().
        const listed = await client.listTools();
        expect(listed.tools).toEqual([{ name: 'lookup_order', description: 'Look up an order by id', inputSchema: { type: 'object' } }]);
        expect(customTransport.clientRequests.map(m => m.method)).toEqual([...handshakeRequests, 'tools/list']);

        await client.close();

        // close() reached the consumer transport, and its onclose callback fed back into the client's close handling.
        expect(customTransport.events).toEqual(['start', ...handshake, 'send:tools/list', 'close']);
        expect(clientOnclose).toHaveBeenCalledTimes(1);
        expect(client.transport).toBeUndefined();
    } finally {
        await client.close();
    }
});

verifies('protocol:transport-callbacks:wrappable-after-connect', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('echo', { inputSchema: z.object({ text: z.string() }) }, ({ text }) => ({
            content: [{ type: 'text', text }]
        }));
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const tx = client.transport;
    if (!tx) throw new Error('client transport not set after connect');

    // Protocol assigned all three handlers at connect time, so a consumer has originals to chain to.
    const protocolOnMessage = tx.onmessage;
    const protocolOnClose = tx.onclose;
    const protocolOnError = tx.onerror;
    expect(protocolOnMessage).toBeDefined();
    expect(protocolOnClose).toBeDefined();
    expect(protocolOnError).toBeDefined();

    // Consumer-style wrapping after connect: record, then delegate to the original handlers.
    const observedMessages: JSONRPCMessage[] = [];
    const observedErrors: Error[] = [];
    tx.onmessage = (message: JSONRPCMessage, extra?: MessageExtraInfo) => {
        observedMessages.push(message);
        protocolOnMessage?.(message, extra);
    };
    tx.onerror = (error: Error) => {
        observedErrors.push(error);
        protocolOnError?.(error);
    };
    tx.onclose = () => {
        protocolOnClose?.();
    };

    const outbound = tapOutbound(client);

    const first = await client.callTool({ name: 'echo', arguments: { text: 'wrapped dispatch' } });
    expect(first.content).toEqual([{ type: 'text', text: 'wrapped dispatch' }]);
    const second = await client.callTool({ name: 'echo', arguments: { text: 'still wrapped' } });
    expect(second.content).toEqual([{ type: 'text', text: 'still wrapped' }]);

    // The wrapper observed the exact responses that resolved both calls, and no errors surfaced.
    const callIds = outbound
        .filter(m => isRequest(m))
        .filter(m => m.method === 'tools/call')
        .map(m => m.id);
    expect(callIds).toHaveLength(2);
    const [firstCallId, secondCallId] = callIds;
    if (firstCallId === undefined || secondCallId === undefined) throw new Error('tools/call request ids not captured');
    const observedResponsesFor = (id: RequestId) => observedMessages.filter(m => isJSONRPCResultResponse(m)).filter(m => m.id === id);
    expect(observedResponsesFor(firstCallId)).toHaveLength(1);
    expect(observedResponsesFor(firstCallId)[0]?.result).toMatchObject({ content: [{ type: 'text', text: 'wrapped dispatch' }] });
    expect(observedResponsesFor(secondCallId)).toHaveLength(1);
    expect(observedResponsesFor(secondCallId)[0]?.result).toMatchObject({ content: [{ type: 'text', text: 'still wrapped' }] });
    expect(observedErrors).toEqual([]);

    // Close-event chaining is checked on a direct InMemory pair: the in-process stdio harness never fires the client transport's onclose.
    const closingClient = newClient();
    const closingServer = makeServer();
    const [closingClientTx, closingServerTx] = InMemoryTransport.createLinkedPair();
    const closingClientOnclose = vi.fn();
    closingClient.onclose = closingClientOnclose;
    try {
        await closingServer.connect(closingServerTx);
        await closingClient.connect(closingClientTx);

        const protocolCloseHandler = closingClientTx.onclose;
        expect(protocolCloseHandler).toBeDefined();
        let wrapperObservedClose = 0;
        closingClientTx.onclose = () => {
            wrapperObservedClose += 1;
            protocolCloseHandler?.();
        };

        // Server-initiated close: the consumer wrapper sees the close event and protocol close handling still runs through it.
        await closingServer.close();

        expect(wrapperObservedClose).toBe(1);
        expect(closingClientOnclose).toHaveBeenCalledTimes(1);
        expect(closingClient.transport).toBeUndefined();
    } finally {
        await closingClient.close();
        await closingServer.close();
    }
});
