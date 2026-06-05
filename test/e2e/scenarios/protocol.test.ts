/**
 * Protocol-layer tests: cancellation, errors, progress, timeouts, custom methods.
 *
 * Tests covering the request/response lifecycle independent of specific MCP
 * features like tools or resources. Most test both McpServer and raw Server
 * via the requirement's tier map.
 */

import { expect, vi } from 'vitest';
import { z } from 'zod/v4';

import { Client } from '../../../src/client/index.js';
import { InMemoryTransport } from '../../../src/inMemory.js';
import { Server } from '../../../src/server/index.js';
import { McpServer } from '../../../src/server/mcp.js';
import type { Transport } from '../../../src/shared/transport.js';
import {
    type CallToolRequest,
    CallToolRequestSchema,
    CreateMessageRequestSchema,
    CreateMessageResultSchema,
    ErrorCode,
    isJSONRPCErrorResponse,
    isJSONRPCResultResponse,
    type JSONRPCMessage,
    type JSONRPCNotification,
    type JSONRPCRequest,
    type JSONRPCResponse,
    ListRootsRequestSchema,
    ListRootsResultSchema,
    ListToolsRequestSchema,
    McpError,
    type Notification,
    NotificationSchema,
    PingRequestSchema,
    type Progress,
    PromptListChangedNotificationSchema,
    type RequestId,
    RequestSchema,
    type Result,
    ResultSchema,
    ToolListChangedNotificationSchema
} from '../../../src/types.js';

import { tapWire, wire } from '../helpers/index.js';
import type { TestArgs } from '../types.js';
import { verifies } from '../helpers/verifies.js';

const newClient = () => new Client({ name: 'c', version: '0' });

/** Raw {@link Server} factory whose tools/list never resolves — for timeout / connection-closed tests. */
function neverRespondingServer(): Server {
    const s = new Server({ name: 's', version: '0' }, { capabilities: { tools: {} } });
    s.setRequestHandler(
        ListToolsRequestSchema,
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

verifies('protocol:cancel:abort-signal', async ({ transport, protocolVersion }: TestArgs) => {
    const stalled: Array<() => void> = [];
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool(
            'echo',
            { inputSchema: z.object({ text: z.string() }) },
            async ({ text }, extra) =>
                new Promise(resolve => {
                    const t = setTimeout(() => resolve({ content: [{ type: 'text', text }] }), 60_000);
                    t.unref();
                    stalled.push(() => {
                        clearTimeout(t);
                        resolve({ content: [{ type: 'text', text: 'late' }] });
                    });
                    extra.signal.addEventListener('abort', () => {
                        clearTimeout(t);
                    });
                })
        );
        return s;
    };
    const client = newClient();
    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const outbound: JSONRPCMessage[] = [];
    const originalSend = client.transport!.send.bind(client.transport!);
    client.transport!.send = async m => {
        outbound.push(m);
        return originalSend(m);
    };

    const controller = new AbortController();
    const call = client.callTool({ name: 'echo', arguments: { text: 'never' } }, undefined, {
        signal: controller.signal
    });
    call.catch(() => {});

    await vi.waitFor(() => outbound.some(m => 'method' in m && m.method === 'tools/call'));
    const callMsg = outbound.find(
        (m): m is Extract<JSONRPCMessage, { method: string; id: RequestId }> => 'method' in m && m.method === 'tools/call' && 'id' in m
    )!;

    controller.abort('user requested cancellation');

    await expect(call).rejects.toThrow(/user requested cancellation/);

    await vi.waitFor(() => outbound.some(m => 'method' in m && m.method === 'notifications/cancelled'));
    const cancelled = outbound.find(m => 'method' in m && m.method === 'notifications/cancelled') as {
        id?: RequestId;
        params?: { requestId?: RequestId; reason?: string };
    };

    expect(cancelled).not.toHaveProperty('id');
    expect(cancelled.params?.requestId).toBe(callMsg.id);
    expect(cancelled.params?.reason).toContain('user requested cancellation');
});

verifies('protocol:cancel:handler-abort-propagates', async ({ transport, protocolVersion }: TestArgs) => {
    const aborts: Array<{ requestId: RequestId; reason: unknown }> = [];
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool(
            'cancellable',
            { inputSchema: z.object({}) },
            async (_a, extra) =>
                new Promise((resolve, reject) => {
                    extra.signal.addEventListener('abort', () => {
                        aborts.push({ requestId: extra.requestId, reason: extra.signal.reason });
                        reject(new Error(extra.signal.reason));
                    });
                })
        );
        return s;
    };
    const client = newClient();
    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const ac = new AbortController();
    const call = client.callTool({ name: 'cancellable', arguments: {} }, undefined, { signal: ac.signal });
    call.catch(() => {});

    await new Promise(resolve => setTimeout(resolve, 50));

    ac.abort(new Error('user cancelled'));

    await expect(call).rejects.toThrow('user cancelled');

    await vi.waitFor(() => expect(aborts.length).toBeGreaterThan(0));

    // Server-side signal.reason carries the cancellation reason text from the
    // notifications/cancelled the client sent (possibly wrapped).
    expect(String(aborts[0].reason)).toContain('user cancelled');
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

    await vi.waitFor(() => expect(outbound.filter(isRequest).some(m => m.method === 'initialize')).toBe(true));
    const initReq = outbound.filter(isRequest).find(m => m.method === 'initialize');
    expect(initReq?.id).toBeDefined();

    ac.abort(new Error('user aborted connect'));
    await expect(connecting).rejects.toThrow();

    await new Promise(resolve => setTimeout(resolve, 50));

    const cancelledForInit = outbound
        .filter(isNotification)
        .filter(m => m.method === 'notifications/cancelled' && m.params?.requestId === initReq?.id);
    expect(cancelledForInit).toEqual([]);

    await client.close();
});

verifies('protocol:cancel:late-response-ignored', async ({ transport, protocolVersion }: TestArgs) => {
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
    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const outbound: JSONRPCMessage[] = [];
    const originalSend = client.transport!.send.bind(client.transport!);
    client.transport!.send = async m => {
        outbound.push(m);
        return originalSend(m);
    };

    const errors: Error[] = [];
    client.onerror = e => errors.push(e);

    const ac = new AbortController();
    const call = client.callTool({ name: 'echo', arguments: { text: 'late' } }, undefined, { signal: ac.signal });
    call.catch(() => {});

    await vi.waitFor(() => outbound.some(m => 'method' in m && m.method === 'tools/call'));
    const callReq = outbound.find(
        (m): m is Extract<JSONRPCMessage, { method: string; id: RequestId }> => 'method' in m && m.method === 'tools/call' && 'id' in m
    )!;
    const callId = callReq.id;

    ac.abort(new Error('user cancelled'));

    await vi.waitFor(() => outbound.some(m => 'method' in m && m.method === 'notifications/cancelled'));

    await expect(call).rejects.toThrow('user cancelled');

    const lateResponse: JSONRPCMessage = {
        jsonrpc: '2.0',
        id: callId,
        result: { content: [{ type: 'text', text: 'late' }] }
    };
    client.transport!.onmessage?.(lateResponse);

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(errors).toEqual([]);

    await expect(client.ping()).resolves.toBeDefined();
});

verifies('protocol:cancel:unknown-id-ignored', async ({ transport, protocolVersion }: TestArgs) => {
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
    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const tap = tapWire(client);

    const result = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
    expect(result.content).toEqual([{ type: 'text', text: 'hi' }]);

    await expect(
        client.notification({
            method: 'notifications/cancelled',
            params: { requestId: 99999, reason: 'unknown numeric id' }
        })
    ).resolves.toBeUndefined();

    await expect(
        client.notification({
            method: 'notifications/cancelled',
            params: { requestId: 'never-issued-abc', reason: 'unknown string id' }
        })
    ).resolves.toBeUndefined();

    // Third arm: an id that WAS issued but whose request already completed (the echo
    // call above) — same silent-ignore contract as a never-issued id.
    const echoId = tap.sent.filter(isRequest).find(m => m.method === 'tools/call')?.id;
    expect(echoId).toBeDefined();
    await expect(
        client.notification({
            method: 'notifications/cancelled',
            params: { requestId: echoId!, reason: 'request already completed' }
        })
    ).resolves.toBeUndefined();

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(errors).toEqual([]);

    await expect(client.ping()).resolves.toBeDefined();
});

verifies('typescript:protocol:cancel:request-id-zero', async ({ transport, protocolVersion }: TestArgs) => {
    const started: Array<{ requestId: RequestId; signal: AbortSignal }> = [];
    let release!: () => void;
    const released = new Promise<void>(resolve => {
        release = resolve;
    });
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('wait', { inputSchema: z.object({}) }, async (_a, extra) => {
            started.push({ requestId: extra.requestId, signal: extra.signal });
            await released;
            return { content: [] };
        });
        return s;
    };
    const client = newClient();
    await using _ = await wire({ transport, protocolVersion }, makeServer, client);
    try {
        // The client's own id 0 went to initialize, so a server-side in-flight request
        // with id 0 has to be injected directly onto the wire; any eventual response to
        // it is unknown to the client's Protocol instance, hence the onerror swallow.
        client.onerror = () => {};
        await client.transport!.send({
            jsonrpc: '2.0',
            id: 0,
            method: 'tools/call',
            params: { name: 'wait', arguments: {} }
        });
        await vi.waitFor(() => expect(started).toHaveLength(1));
        expect(started[0].requestId).toBe(0);

        await client.notification({
            method: 'notifications/cancelled',
            params: { requestId: 0, reason: 'cancel the id-0 request' }
        });
        // A full round-trip plus settle time: the cancellation has definitely been processed.
        await expect(client.ping()).resolves.toBeDefined();
        await new Promise(resolve => setTimeout(resolve, 50));

        expect(started[0].signal.aborted).toBe(true);
    } finally {
        release();
    }
});

verifies('typescript:protocol:error:connection-closed', async ({ transport, protocolVersion }: TestArgs) => {
    const client = newClient();
    await using _ = await wire({ transport, protocolVersion }, neverRespondingServer, client);

    const onclose = vi.fn();
    client.onclose = onclose;

    const inFlight = [client.listTools(), client.listTools(), client.listTools()];
    for (const p of inFlight) p.catch(() => {});

    await new Promise(resolve => setTimeout(resolve, 50));
    expect(onclose).not.toHaveBeenCalled();

    await client.close();

    for (const p of inFlight) {
        await expect(p).rejects.toBeInstanceOf(McpError);
        await expect(p).rejects.toMatchObject({ code: ErrorCode.ConnectionClosed });
        // Consumers match the close rejection as a duck shape — literal code -32000 plus a
        // message containing 'Connection closed' — so pin both halves, not just the enum member.
        await expect(p).rejects.toMatchObject({ code: -32000 });
        await expect(p).rejects.toThrow('Connection closed');
    }
    // onclose fires at least once (transport peers may echo a close back, so don't pin the count).
    await vi.waitFor(() => expect(onclose).toHaveBeenCalled());
});

verifies('protocol:error:internal-error', async ({ transport, protocolVersion }: TestArgs) => {
    // Uses raw Server so the throw reaches the protocol layer; McpServer.registerTool
    // catches handler exceptions and wraps as {isError:true} (covered in tools.ts).
    const makeServer = () => {
        const s = new Server({ name: 's', version: '0' }, { capabilities: { tools: {} } });
        s.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
        s.setRequestHandler(CallToolRequestSchema, () => {
            throw new Error('handler exploded');
        });
        return s;
    };
    const client = newClient();
    await using wired = await wire({ transport, protocolVersion }, makeServer, client);

    const call = client.callTool({ name: 'any', arguments: {} });

    await expect(call).rejects.toBeInstanceOf(McpError);
    await expect(call).rejects.toMatchObject({ code: ErrorCode.InternalError });
    await expect(call).rejects.toThrow(/handler exploded/);
    expect(ErrorCode.InternalError).toBe(-32603);

    // Wire-level arm (HTTP hosting only): drive a second, raw JSON-RPC session
    // through the same host without the SDK client, proving -32603 is authored by
    // the SERVER on the wire — the parsed rejection above cannot distinguish a
    // server-sent code from a client-side remap.
    if (wired.fetch && wired.url) {
        const post = (body: Record<string, unknown>, sessionId?: string) =>
            wired.fetch!(wired.url!, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    accept: 'application/json, text/event-stream',
                    'mcp-protocol-version': protocolVersion,
                    ...(sessionId ? { 'mcp-session-id': sessionId } : {})
                },
                body: JSON.stringify(body)
            });
        const messagesOf = async (res: Response): Promise<unknown[]> => {
            const text = await res.text();
            if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
                return text
                    .split('\n')
                    .filter(line => line.startsWith('data:'))
                    .map(line => JSON.parse(line.slice(5)) as unknown);
            }
            return text === '' ? [] : [JSON.parse(text) as unknown];
        };

        const initRes = await post({
            jsonrpc: '2.0',
            id: 'raw-init',
            method: 'initialize',
            params: { protocolVersion, capabilities: {}, clientInfo: { name: 'raw-probe', version: '0' } }
        });
        expect(initRes.status).toBe(200);
        const sessionId = initRes.headers.get('mcp-session-id') ?? undefined;
        await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId);

        const callRes = await post(
            { jsonrpc: '2.0', id: 'raw-call', method: 'tools/call', params: { name: 'any', arguments: {} } },
            sessionId
        );
        const reply = (await messagesOf(callRes)).find(m => (m as { id?: unknown }).id === 'raw-call');
        expect(reply).toBeDefined();
        expect(reply).toMatchObject({ jsonrpc: '2.0', error: { code: -32603, message: expect.stringMatching(/handler exploded/) } });
    }
});

verifies('protocol:error:invalid-params', async ({ transport, protocolVersion }: TestArgs) => {
    // Raw Server: setRequestHandler parses the inbound request against
    // CallToolRequestSchema; missing the required `name` field should yield
    // -32602 InvalidParams at the protocol layer (not McpServer's tool-arg validation).
    const makeServer = () => {
        const s = new Server({ name: 's', version: '0' }, { capabilities: { tools: {} } });
        s.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
        s.setRequestHandler(CallToolRequestSchema, () => ({ content: [] }));
        return s;
    };
    const client = newClient();
    // strictValidation off so the malformed request reaches the server instead of being rejected by the wire sniffer.
    await using _ = await wire({ transport, protocolVersion }, makeServer, client, { strictValidation: false });

    const outbound = tapOutbound(client);

    // Send tools/call without the required `name` field.
    const call = client.request({ method: 'tools/call', params: { arguments: {} } }, z.object({}).passthrough());

    await expect(call).rejects.toBeInstanceOf(McpError);

    // The malformed request did reach the wire (failure is server-side, not client-side validation).
    const sent = outbound.filter(isRequest).find(m => m.method === 'tools/call');
    expect(sent?.params).toEqual({ arguments: {} });

    expect(ErrorCode.InvalidParams).toBe(-32602);
    await expect(call).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
});

verifies('protocol:error:method-not-found', async ({ transport, protocolVersion }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        return s;
    };
    const client = newClient();
    await using _ = await wire({ transport, protocolVersion }, makeServer, client, { allowCustomMethods: true });

    const outbound: JSONRPCMessage[] = [];
    const originalSend = client.transport!.send.bind(client.transport!);
    client.transport!.send = async m => {
        outbound.push(m);
        return originalSend(m);
    };

    const call = client.request({ method: 'no/such/method' }, z.object({}));

    await expect(call).rejects.toBeInstanceOf(McpError);

    const err = await call.catch(e => e as McpError);
    expect(err.code).toBe(ErrorCode.MethodNotFound);
    expect(err.code).toBe(-32601);

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

    await vi.waitFor(() => expect(sentOnA.filter(isRequest).some(m => m.method === 'tools/list')).toBe(true));

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

    expect(sentOnB.filter(isNotification).filter(m => m.method === 'notifications/cancelled')).toEqual([]);
    expect(clientErrors).toEqual([]);

    // The reconnected session is healthy.
    await expect(client.ping()).resolves.toBeDefined();
    expect(sentOnB.filter(isRequest).some(m => m.method === 'ping')).toBe(true);

    await client.close();
    await serverB.close();
});

verifies('protocol:progress:callback', async ({ transport, protocolVersion }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('progress', { inputSchema: z.object({ steps: z.number().int().positive() }) }, async ({ steps }, extra) => {
            const token = extra._meta?.progressToken;
            if (token !== undefined) {
                for (let i = 1; i <= steps; i++) {
                    await extra.sendNotification({
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
    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const updates: Progress[] = [];

    await client.callTool({ name: 'progress', arguments: { steps: 2 } }, undefined, {
        onprogress: p => updates.push(p)
    });

    expect(updates).toHaveLength(2);

    expect(updates[0]).toMatchObject({ progress: 1, total: 2, message: 'step 1/2' });
    expect(updates[1]).toMatchObject({ progress: 2, total: 2, message: 'step 2/2' });

    expect(updates[0]).not.toHaveProperty('progressToken');
});

verifies('typescript:protocol:progress:token-injected', async ({ transport, protocolVersion }: TestArgs) => {
    const received: CallToolRequest['params'][] = [];
    const makeServer = () => {
        const s = new Server({ name: 's', version: '0' }, { capabilities: { tools: {} } });
        s.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
        s.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
            received.push(req.params);
            const token = req.params._meta?.progressToken;
            if (token !== undefined) {
                await extra.sendNotification({
                    method: 'notifications/progress',
                    params: { progressToken: token, progress: 1, total: 1 }
                });
            }
            return { content: [{ type: 'text', text: 'ok' }] };
        });
        return s;
    };
    const client = newClient();
    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const traceKey = 'example.com/trace-id';
    const traceId = 'trace-abc-123';
    const progressEvents: Progress[] = [];

    const result = await client.callTool({ name: 'any', arguments: {}, _meta: { [traceKey]: traceId } }, undefined, {
        onprogress: p => progressEvents.push(p)
    });

    expect(result.isError).toBeFalsy();
    expect(progressEvents).toEqual([expect.objectContaining({ progress: 1, total: 1 })]);

    expect(received).toHaveLength(1);
    const meta = received[0]._meta;
    expect(meta?.progressToken).toBeDefined();
    expect(['number', 'string']).toContain(typeof meta?.progressToken);
    // Existing _meta fields are preserved alongside the injected token.
    expect(meta?.[traceKey]).toBe(traceId);
});

verifies('protocol:progress:token-unique', async ({ transport, protocolVersion }: TestArgs) => {
    const tokens: Array<string | number> = [];
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('probe', { inputSchema: z.object({}) }, async (_a, extra) => {
            const token = extra._meta?.progressToken;
            if (token !== undefined) {
                tokens.push(token);
                await extra.sendNotification({
                    method: 'notifications/progress',
                    params: { progressToken: token, progress: 1, total: 1 }
                });
            }
            return { content: [] };
        });
        return s;
    };
    const client = newClient();
    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const a = client.callTool({ name: 'probe', arguments: {} }, undefined, { onprogress: () => {} });
    const b = client.callTool({ name: 'probe', arguments: {} }, undefined, { onprogress: () => {} });

    await Promise.all([a, b]);

    expect(tokens).toHaveLength(2);
    expect(tokens[0]).not.toBe(tokens[1]);
});

verifies('typescript:protocol:progress:concurrent-isolation', async ({ transport, protocolVersion }: TestArgs) => {
    // Both handlers must be in flight before either emits progress — if the requests
    // serialized, a broadcast dispatch would be invisible (the other request's
    // progress handler would not be registered yet).
    let startedCount = 0;
    let releaseBoth!: () => void;
    const bothStarted = new Promise<void>(resolve => {
        releaseBoth = resolve;
    });
    const arrive = () => {
        startedCount += 1;
        if (startedCount === 2) releaseBoth();
    };
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('progress', { inputSchema: z.object({ steps: z.number().int().positive() }) }, async ({ steps }, extra) => {
            const token = extra._meta?.progressToken;
            arrive();
            await bothStarted;
            if (token !== undefined) {
                for (let i = 1; i <= steps; i++) {
                    await extra.sendNotification({
                        method: 'notifications/progress',
                        params: { progressToken: token, progress: i, total: steps, message: `step ${i}/${steps}` }
                    });
                }
            }
            return { content: [{ type: 'text', text: `done after ${steps} steps` }] };
        });
        return s;
    };
    const client = newClient();
    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const updatesA: Progress[] = [];
    const updatesB: Progress[] = [];

    await Promise.all([
        client.callTool({ name: 'progress', arguments: { steps: 2 } }, undefined, { onprogress: p => updatesA.push(p) }),
        client.callTool({ name: 'progress', arguments: { steps: 3 } }, undefined, { onprogress: p => updatesB.push(p) })
    ]);

    // Each collector saw exactly its own request's updates — by count, order, and total.
    // A broadcast dispatch would deliver all five updates to both collectors.
    expect(updatesA.map(p => p.progress)).toEqual([1, 2]);
    expect(updatesB.map(p => p.progress)).toEqual([1, 2, 3]);
    expect(updatesA.map(p => p.total)).toEqual([2, 2]);
    expect(updatesB.map(p => p.total)).toEqual([3, 3, 3]);
});

verifies('protocol:timeout:basic', async ({ transport, protocolVersion }: TestArgs) => {
    vi.useFakeTimers();
    try {
        const client = newClient();
        await using _ = await wire({ transport, protocolVersion }, neverRespondingServer, client);

        const outbound = tapOutbound(client);

        let outcome: { kind: 'resolved' | 'rejected'; value: unknown } | undefined;
        const pending = client.listTools(undefined, { timeout: 100 });
        void pending.then(
            v => (outcome = { kind: 'resolved', value: v }),
            (e: unknown) => (outcome = { kind: 'rejected', value: e })
        );

        await vi.advanceTimersByTimeAsync(0);
        expect(outbound.filter(isRequest).some(m => m.method === 'tools/list')).toBe(true);
        expect(outcome).toBeUndefined();

        await vi.advanceTimersByTimeAsync(99);
        expect(outcome).toBeUndefined();

        await vi.advanceTimersByTimeAsync(2);
        expect(outcome?.kind).toBe('rejected');
        expect(outcome?.value).toBeInstanceOf(McpError);
        expect(outcome?.value).toMatchObject({ code: ErrorCode.RequestTimeout });
    } finally {
        vi.useRealTimers();
    }
});

verifies('protocol:timeout:max-total', async ({ transport, protocolVersion }: TestArgs) => {
    vi.useFakeTimers();
    try {
        const makeServer = () => {
            const s = new McpServer({ name: 's', version: '0' });
            s.registerTool(
                'slow-progress',
                { inputSchema: z.object({ delayMs: z.number(), steps: z.number() }) },
                async ({ delayMs, steps }, extra) => {
                    const token = extra._meta?.progressToken;
                    if (token !== undefined) {
                        for (let i = 1; i <= steps; i++) {
                            await new Promise(resolve => setTimeout(resolve, delayMs));
                            await extra.sendNotification({
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
        await using _ = await wire({ transport, protocolVersion }, makeServer, client);

        const perChunk = 500;
        const maxTotal = 1000;
        const delayMs = 200;

        const ticks: number[] = [];

        const call = client.callTool({ name: 'slow-progress', arguments: { delayMs, steps: 100 } }, undefined, {
            timeout: perChunk,
            resetTimeoutOnProgress: true,
            maxTotalTimeout: maxTotal,
            onprogress: p => ticks.push(p.progress)
        });
        call.catch(() => {});

        for (let elapsed = 0; elapsed < maxTotal + perChunk; elapsed += delayMs) {
            await vi.advanceTimersByTimeAsync(delayMs);
        }

        await expect(call).rejects.toBeInstanceOf(McpError);
        const err = await call.catch(e => e as McpError);
        expect(err.code).toBe(ErrorCode.RequestTimeout);

        expect(ticks.length).toBeGreaterThanOrEqual(3);
    } finally {
        vi.useRealTimers();
    }
});

verifies('protocol:timeout:reset-on-progress', async ({ transport, protocolVersion }: TestArgs) => {
    vi.useFakeTimers();
    try {
        const makeServer = () => {
            const s = new McpServer({ name: 's', version: '0' });
            s.registerTool(
                'slow-progress',
                { inputSchema: z.object({ steps: z.number(), delayMs: z.number() }) },
                async ({ steps, delayMs }, extra) => {
                    const token = extra._meta?.progressToken;
                    if (token !== undefined) {
                        for (let i = 1; i <= steps; i++) {
                            await new Promise(resolve => setTimeout(resolve, delayMs));
                            await extra.sendNotification({
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
        await using _ = await wire({ transport, protocolVersion }, makeServer, client);

        const timeout = 200;
        const steps = 3;
        const delayMs = 150;

        const received: number[] = [];
        let settled: 'resolved' | 'rejected' | undefined;

        const call = client
            .callTool({ name: 'slow-progress', arguments: { steps, delayMs } }, undefined, {
                timeout,
                resetTimeoutOnProgress: true,
                onprogress: p => {
                    received.push(p.progress);
                }
            })
            .then(
                r => ((settled = 'resolved'), r),
                e => ((settled = 'rejected'), Promise.reject(e))
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

verifies('typescript:protocol:timeout:rearm-fires', async ({ transport, protocolVersion }: TestArgs) => {
    vi.useFakeTimers();
    try {
        // One progress notification at t=150, then silence forever.
        const makeServer = () => {
            const s = new McpServer({ name: 's', version: '0' });
            s.registerTool('one-progress', { inputSchema: z.object({}) }, async (_a, extra) => {
                const token = extra._meta?.progressToken;
                if (token !== undefined) {
                    await new Promise(resolve => setTimeout(resolve, 150));
                    await extra.sendNotification({
                        method: 'notifications/progress',
                        params: { progressToken: token, progress: 1, message: 'only step' }
                    });
                }
                return new Promise(() => {
                    /* never resolves */
                });
            });
            return s;
        };
        const client = newClient();
        await using _ = await wire({ transport, protocolVersion }, makeServer, client);

        const timeout = 200;
        const updates: Progress[] = [];
        let outcome: { kind: 'resolved' | 'rejected'; value: unknown } | undefined;

        const call = client.callTool({ name: 'one-progress', arguments: {} }, undefined, {
            timeout,
            resetTimeoutOnProgress: true,
            onprogress: p => updates.push(p)
        });
        void call.then(
            v => (outcome = { kind: 'resolved', value: v }),
            (e: unknown) => (outcome = { kind: 'rejected', value: e })
        );

        // t=150: the single progress notification arrives inside the original 200ms
        // deadline and re-arms the read timeout (due again 200ms after the reset).
        // NOTE: with fake timers active, vi.waitFor advances the clock 50ms per check,
        // so no assertion below may depend on an exact post-waitFor clock value.
        await vi.advanceTimersByTimeAsync(150);
        await vi.waitFor(() => expect(updates).toHaveLength(1));
        // Progress arrived while the call was still live, so the reset applied to a
        // pending request (had the original deadline fired first, outcome would be set).
        expect(outcome).toBeUndefined();

        // No further progress: the RE-ARMED timer must actually fire. Advance far past
        // any possible re-armed deadline — a clear-and-never-re-arm implementation
        // (which protocol:timeout:reset-on-progress cannot distinguish) leaves the
        // request hanging forever here instead of failing it.
        await vi.advanceTimersByTimeAsync(1000);
        expect(outcome?.kind).toBe('rejected');
        expect(outcome?.value).toBeInstanceOf(McpError);
        expect(outcome?.value).toMatchObject({ code: ErrorCode.RequestTimeout });
    } finally {
        vi.useRealTimers();
    }
});

verifies('protocol:timeout:sends-cancellation', async ({ transport, protocolVersion }: TestArgs) => {
    vi.useFakeTimers();
    try {
        const client = newClient();
        await using _ = await wire({ transport, protocolVersion }, neverRespondingServer, client);

        const outbound = tapOutbound(client);

        const pending = client.listTools(undefined, { timeout: 100 });
        // Snapshot at rejection time so the cancellation-before-reject ordering is actually observed.
        let sentAtRejection: JSONRPCMessage[] | undefined;
        pending.catch(() => {
            sentAtRejection = [...outbound];
        });

        await vi.advanceTimersByTimeAsync(100);

        await expect(pending).rejects.toBeInstanceOf(McpError);
        await expect(pending).rejects.toMatchObject({ code: ErrorCode.RequestTimeout });

        expect(sentAtRejection).toBeDefined();
        const listReq = sentAtRejection!.filter(isRequest).find(m => m.method === 'tools/list');
        expect(listReq).toBeDefined();

        const cancelled = sentAtRejection!.filter(isNotification).find(m => m.method === 'notifications/cancelled');
        expect(cancelled, 'notifications/cancelled must be handed to transport.send() before the request promise rejects').toBeDefined();
        expect(cancelled?.params?.requestId).toBe(listReq?.id);
        expect(String(cancelled?.params?.reason)).toMatch(/timed? ?out/i);
        expect(sentAtRejection!.indexOf(cancelled!)).toBeGreaterThan(sentAtRejection!.indexOf(listReq!));
    } finally {
        vi.useRealTimers();
    }
});

verifies('mcpserver:onerror:reach-through', async ({ transport, protocolVersion }: TestArgs) => {
    const errors: Error[] = [];
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.server.onerror = e => errors.push(e);
        return s;
    };
    const client = newClient();
    await using _ = await wire({ transport, protocolVersion }, makeServer, client, { strictValidation: false });

    const baseA = errors.length;
    const stray: JSONRPCMessage = { jsonrpc: '2.0', id: 99999, result: {} };
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
    expect(hitA!.message).toContain('99999');

    const baseB = errors.length;
    const badProgress = {
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: { progressToken: 'onerror-reach-through', progress: 'not-a-number' }
    } as unknown as JSONRPCMessage;
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
});

verifies('protocol:custom-method:notification', async ({ transport, protocolVersion }: TestArgs) => {
    const HEARTBEAT_METHOD = 'myorg/heartbeat';

    const CustomNotificationSchema = NotificationSchema.extend({
        method: z.literal(HEARTBEAT_METHOD),
        params: z.object({ seq: z.number(), tag: z.string() })
    });
    type CustomNotification = z.infer<typeof CustomNotificationSchema>;

    let server!: Server;
    const makeServer = () => (server = new Server({ name: 's', version: '0' }, { capabilities: {} }));

    const received: CustomNotification[] = [];
    const clientErrors: Error[] = [];
    const client = newClient();
    client.onerror = e => clientErrors.push(e);

    await using _ = await wire({ transport, protocolVersion }, makeServer, client, { allowCustomMethods: true });

    client.setNotificationHandler(CustomNotificationSchema, n => {
        received.push(n);
    });

    await server.notification({
        method: HEARTBEAT_METHOD,
        params: { seq: 7, tag: 'custom', extra: 'stripped-by-zod' }
    });

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0].method).toBe(HEARTBEAT_METHOD);
    // Handler receives the Zod-parsed params (extra fields stripped).
    expect(received[0].params).toEqual({ seq: 7, tag: 'custom' });
    expect(received[0].params).not.toHaveProperty('extra');
    expect(clientErrors).toEqual([]);
});

verifies('protocol:error:data-roundtrip', async ({ transport, protocolVersion }: TestArgs) => {
    // Raw Server so the McpError reaches the protocol layer's error envelope.
    const data = { detail: 'x', nested: { n: 1 } };
    const makeServer = () => {
        const s = new Server({ name: 's', version: '0' }, { capabilities: { tools: {} } });
        s.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
        s.setRequestHandler(CallToolRequestSchema, () => {
            throw new McpError(ErrorCode.InternalError, 'boom', data);
        });
        return s;
    };
    const client = newClient();
    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const call = client.callTool({ name: 'any', arguments: {} });

    await expect(call).rejects.toBeInstanceOf(McpError);
    await expect(call).rejects.toThrow(/boom/);
    await expect(call).rejects.toMatchObject({ code: ErrorCode.InternalError, data });
});

verifies(
    'protocol:error:data-roundtrip',
    async ({ transport, protocolVersion }: TestArgs) => {
        // McpServer path: the spec-correct outcome is the same rejection the raw-Server arm proves,
        // but McpServer's tool-handler catch converts the McpError into an {isError:true} text result
        // (which cannot carry .data), so callTool resolves instead — see the knownFailure entry.
        const data = { detail: 'x', nested: { n: 1 } };
        const makeServer = () => {
            const s = new McpServer({ name: 's', version: '0' });
            s.registerTool('explode', { inputSchema: z.object({}) }, () => {
                throw new McpError(ErrorCode.InvalidParams, 'boom', data);
            });
            return s;
        };
        const client = newClient();
        await using _ = await wire({ transport, protocolVersion }, makeServer, client);

        const call = client.callTool({ name: 'explode', arguments: {} });

        await expect(call).rejects.toBeInstanceOf(McpError);
        await expect(call).rejects.toMatchObject({ code: ErrorCode.InvalidParams, data });
    },
    { title: 'mcpserver tool path' }
);

verifies('typescript:protocol:error:data-absent', async ({ transport, protocolVersion }: TestArgs) => {
    // Raw Server so the thrown McpError reaches the protocol layer's error envelope.
    const makeServer = () => {
        const s = new Server({ name: 's', version: '0' }, { capabilities: { tools: {} } });
        s.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
        s.setRequestHandler(CallToolRequestSchema, () => {
            throw new McpError(ErrorCode.InternalError, 'boom with no data');
        });
        return s;
    };
    const client = newClient();
    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const tap = tapWire(client);

    const call = client.callTool({ name: 'any', arguments: {} });
    await expect(call).rejects.toBeInstanceOf(McpError);
    const err = await call.catch(e => e as McpError);
    expect(err.code).toBe(ErrorCode.InternalError);
    // The thrown error carried no data, so neither does the rejection...
    expect(err.data).toBeUndefined();

    // ...and the wire envelope omits the member entirely (no data: null).
    const errorResponses = tap.received.filter(isJSONRPCErrorResponse);
    expect(errorResponses).toHaveLength(1);
    expect('data' in errorResponses[0].error).toBe(false);
});

verifies('protocol:fallback-notification-handler', async ({ transport, protocolVersion }: TestArgs) => {
    const NEVER_REGISTERED = 'notifications/_e2e/never-registered';

    // Notifications are emitted from inside the tools/call handler so they cross the real wire on every transport, including stateless hosting.
    const makeServer = () => {
        const s = new Server(
            { name: 's', version: '0' },
            { capabilities: { tools: { listChanged: true }, prompts: { listChanged: true } } }
        );
        s.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
        s.setRequestHandler(CallToolRequestSchema, async (_req, extra) => {
            await extra.sendNotification({ method: NEVER_REGISTERED });
            await extra.sendNotification({ method: 'notifications/prompts/list_changed' });
            await extra.sendNotification({ method: 'notifications/tools/list_changed' });
            return { content: [] };
        });
        return s;
    };
    const client = newClient();

    const fallback: Notification[] = [];
    const specific: Notification[] = [];

    await using _ = await wire({ transport, protocolVersion }, makeServer, client, { allowCustomMethods: true });

    client.setNotificationHandler(ToolListChangedNotificationSchema, async n => {
        specific.push(n);
    });
    client.setNotificationHandler(PromptListChangedNotificationSchema, async n => {
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

verifies('protocol:handler:re-register-replaces', async ({ transport, protocolVersion }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('list-roots', { inputSchema: z.object({}) }, async (_a, extra) => {
            const result = await extra.sendRequest({ method: 'roots/list' }, ListRootsResultSchema);
            return { structuredContent: { ok: true, result }, content: [] };
        });
        return s;
    };
    const client = new Client({ name: 'c', version: '0' }, { capabilities: { roots: { listChanged: true } } });
    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    let firstCalls = 0;
    let secondCalls = 0;

    client.setRequestHandler(ListRootsRequestSchema, async () => {
        firstCalls++;
        return { roots: [{ uri: 'file:///first', name: 'first' }] };
    });

    expect(() =>
        client.setRequestHandler(ListRootsRequestSchema, async () => {
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
const XEchoRequestSchema = RequestSchema.extend({
    method: z.literal(X_ECHO_METHOD),
    params: z.object({ value: z.string() })
});
const XEchoResultSchema = ResultSchema.extend({ echoed: z.string() });

function customEchoServer(): Server {
    const s = new Server({ name: 's', version: '0' }, { capabilities: {} });
    s.setRequestHandler(XEchoRequestSchema, req => ({ echoed: req.params.value }));
    return s;
}

verifies('protocol:custom-method:request', async ({ transport, protocolVersion }: TestArgs) => {
    const client = newClient();
    await using _ = await wire({ transport, protocolVersion }, customEchoServer, client, { allowCustomMethods: true });

    const result = await client.request({ method: X_ECHO_METHOD, params: { value: 'hi' } }, XEchoResultSchema);

    expect(result).toEqual({ echoed: 'hi' });
});

verifies('protocol:custom-method:roundtrip', async ({ transport, protocolVersion }: TestArgs) => {
    const client = newClient();
    const clientErrors: Error[] = [];
    client.onerror = e => clientErrors.push(e);
    await using _ = await wire({ transport, protocolVersion }, customEchoServer, client, { allowCustomMethods: true });

    // Custom method dispatches to the user handler — not -32601 MethodNotFound.
    const result = await client.request({ method: X_ECHO_METHOD, params: { value: 'round' } }, XEchoResultSchema);
    expect(result).toEqual({ echoed: 'round' });
    expect(clientErrors).toEqual([]);

    // A truly-unknown method still surfaces as MethodNotFound, proving the
    // custom registration is what made the previous call succeed.
    await expect(client.request({ method: 'x-e2e/never-registered', params: {} }, ResultSchema)).rejects.toMatchObject({
        code: ErrorCode.MethodNotFound
    });
});

verifies('protocol:custom-notification:roundtrip', async ({ transport, protocolVersion }: TestArgs) => {
    const X_EVENT_METHOD = 'x-e2e/event';
    const XEventNotificationSchema = NotificationSchema.extend({
        method: z.literal(X_EVENT_METHOD),
        params: z.object({ kind: z.string(), id: z.number() })
    });
    type XEvent = z.infer<typeof XEventNotificationSchema>;

    const received: XEvent[] = [];
    const serverErrors: Error[] = [];
    const makeServer = () => {
        const s = new Server({ name: 's', version: '0' }, { capabilities: {} });
        s.onerror = e => serverErrors.push(e);
        s.setNotificationHandler(XEventNotificationSchema, n => {
            received.push(n);
        });
        return s;
    };

    const client = newClient();
    await using _ = await wire({ transport, protocolVersion }, makeServer, client, { allowCustomMethods: true });

    await client.notification({ method: X_EVENT_METHOD, params: { kind: 'k', id: 42, extra: 'stripped-by-zod' } });

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0].method).toBe(X_EVENT_METHOD);
    // Handler receives the Zod-parsed params (extra fields stripped), not raw passthrough.
    expect(received[0].params).toEqual({ kind: 'k', id: 42 });
    expect(received[0].params).not.toHaveProperty('extra');
    expect(serverErrors).toEqual([]);
});

verifies('protocol:meta:request-to-handler', async ({ transport, protocolVersion }: TestArgs) => {
    const requestMeta = { 'example.com/trace-id': 'trace-abc-123', 'example.com/tenant': { org: 'acme', region: 'eu-west-1' } };
    const handlerParamsMeta: unknown[] = [];
    const handlerExtraMeta: unknown[] = [];
    const makeServer = () => {
        const s = new Server({ name: 's', version: '0' }, { capabilities: { tools: {} } });
        s.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
        s.setRequestHandler(CallToolRequestSchema, (req, extra) => {
            handlerParamsMeta.push(req.params._meta);
            handlerExtraMeta.push(extra._meta);
            return { content: [{ type: 'text', text: 'traced' }] };
        });
        return s;
    };
    const client = newClient();
    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const result = await client.callTool({ name: 'traced_call', arguments: {}, _meta: requestMeta });

    expect(result.content).toEqual([{ type: 'text', text: 'traced' }]);
    // Exact equality against the sent object: nothing was stripped and nothing (e.g. a progressToken) was injected.
    expect(handlerParamsMeta).toEqual([requestMeta]);
    expect(handlerExtraMeta).toEqual([requestMeta]);
});

verifies('protocol:meta:result-to-client', async ({ transport, protocolVersion }: TestArgs) => {
    const resultMeta = { 'example.com/cost-tokens': 42, 'example.com/cache': { hit: true, region: 'eu-west-1' } };
    const makeServer = () => {
        const s = new Server({ name: 's', version: '0' }, { capabilities: { tools: {} } });
        s.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
        s.setRequestHandler(CallToolRequestSchema, () => ({ content: [{ type: 'text', text: 'metered' }], _meta: resultMeta }));
        return s;
    };
    const client = newClient();
    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const result = await client.callTool({ name: 'metered_call', arguments: {} });

    expect(result.content).toEqual([{ type: 'text', text: 'metered' }]);
    // The _meta the handler attached to its result reaches the requesting client unchanged.
    expect(result._meta).toEqual(resultMeta);
});

verifies('protocol:request-id:unique', async ({ transport, protocolVersion }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('echo', { inputSchema: z.object({ text: z.string() }) }, ({ text }) => ({
            content: [{ type: 'text', text }]
        }));
        return s;
    };
    const client = newClient();
    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const tap = tapWire(client);

    await client.ping();
    await client.listTools();
    await Promise.all([
        client.callTool({ name: 'echo', arguments: { text: 'first' } }),
        client.callTool({ name: 'echo', arguments: { text: 'second' } })
    ]);
    await client.ping();

    const requests = tap.sent.filter(isRequest);
    expect(requests.map(m => m.method).sort()).toEqual(['ping', 'ping', 'tools/call', 'tools/call', 'tools/list']);

    const ids = requests.map(m => m.id);
    for (const id of ids) {
        expect(id).not.toBeNull();
        expect(['string', 'number']).toContain(typeof id);
    }
    // Five requests on the session, five distinct ids — no id is ever reused.
    expect(new Set(ids).size).toBe(5);
});

verifies('typescript:protocol:request-id:sequential', async (_: TestArgs) => {
    // The tap must see the initialize request itself, so wire() (which awaits
    // connect) can't be used. Id allocation lives in shared/protocol.ts and is
    // transport-agnostic; registered on inMemory only (see the requirement note).
    const server = new McpServer({ name: 's', version: '0' });
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTx);

    const outbound: JSONRPCMessage[] = [];
    const origSend = clientTx.send.bind(clientTx);
    clientTx.send = async (m, opts) => {
        outbound.push(m);
        return origSend(m, opts);
    };

    const client = newClient();
    await client.connect(clientTx);

    await client.ping();
    await client.ping();
    await client.ping();
    await client.ping();

    const requests = outbound.filter(isRequest);
    expect(requests.map(m => m.method)).toEqual(['initialize', 'ping', 'ping', 'ping', 'ping']);
    // The session's very first request — initialize — takes id 0, and each later
    // request id is exactly the previous plus one: a dense zero-based sequence,
    // not merely unique ids.
    expect(requests.map(m => m.id)).toEqual([0, 1, 2, 3, 4]);

    await Promise.all([client.close(), server.close()]);
});

verifies('protocol:notifications:no-response', async ({ transport, protocolVersion }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('echo', { inputSchema: z.object({ text: z.string() }) }, ({ text }) => ({
            content: [{ type: 'text', text }]
        }));
        return s;
    };
    const client = new Client({ name: 'c', version: '0' }, { capabilities: { roots: { listChanged: true } } });
    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const tap = tapWire(client);

    await client.sendRootsListChanged();
    await client.notification({
        method: 'notifications/cancelled',
        params: { requestId: 424242, reason: 'request was never issued' }
    });

    const result = await client.callTool({ name: 'echo', arguments: { text: 'after notifications' } });
    expect(result.content).toEqual([{ type: 'text', text: 'after notifications' }]);
    await expect(client.ping()).resolves.toBeDefined();

    // Both requests round-tripped after the notifications, so a (non-conformant) reply to either notification would have arrived by now.
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(tap.sent.filter(isNotification).map(m => m.method)).toEqual(['notifications/roots/list_changed', 'notifications/cancelled']);
    const requestIds = tap.sent.filter(isRequest).map(m => m.id);
    expect(requestIds).toHaveLength(2);

    const responses = tap.received.filter(isResponse);
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

verifies('protocol:progress:monotonic', async ({ transport, protocolVersion }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('index_files', { inputSchema: z.object({}) }, async (_a, extra) => {
            const token = extra._meta?.progressToken;
            if (token === undefined) throw new Error('expected a progressToken on the request');
            await extra.sendNotification({
                method: 'notifications/progress',
                params: { progressToken: token, progress: 5, message: 'indexed 5 files' }
            });
            try {
                // A spec-compliant sender refuses (or drops) this regression to a smaller value.
                await extra.sendNotification({
                    method: 'notifications/progress',
                    params: { progressToken: token, progress: 3, message: 'regressed' }
                });
            } catch {
                /* sender-side rejection of the non-increasing value is a valid way to satisfy the spec */
            }
            await extra.sendNotification({
                method: 'notifications/progress',
                params: { progressToken: token, progress: 12, message: 'indexed 12 files' }
            });
            return { content: [{ type: 'text', text: 'indexing complete' }] };
        });
        return s;
    };
    const client = newClient();
    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const updates: Progress[] = [];
    const result = await client.callTool({ name: 'index_files', arguments: {} }, undefined, { onprogress: p => updates.push(p) });

    expect(result.content).toEqual([{ type: 'text', text: 'indexing complete' }]);

    // Progress flows even though no total was supplied.
    expect(updates.map(p => p.progress)).toContain(5);
    expect(updates.map(p => p.progress)).toContain(12);
    for (const update of updates) {
        expect(update.total).toBeUndefined();
    }
    // Spec: the progress value MUST increase with each notification for the token, so the regressed value never reaches the caller.
    for (let i = 1; i < updates.length; i++) {
        expect(
            updates[i].progress,
            `progress sequence ${updates.map(p => p.progress).join(' → ')} must be strictly increasing`
        ).toBeGreaterThan(updates[i - 1].progress);
    }
});

verifies('protocol:progress:stops-after-completion', async ({ transport, protocolVersion }: TestArgs) => {
    let server!: Server;
    let lateProgress: (() => Promise<void>) | undefined;
    const makeServer = () => {
        server = new Server({ name: 's', version: '0' }, { capabilities: { tools: { listChanged: true } } });
        server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
        server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
            const token = req.params._meta?.progressToken;
            if (token === undefined) throw new Error('expected a progressToken on the request');
            await extra.sendNotification({
                method: 'notifications/progress',
                params: { progressToken: token, progress: 1, total: 2, message: 'halfway' }
            });
            // Captured so the test can attempt a post-completion progress send for the same token through the public API.
            lateProgress = () =>
                server.notification({
                    method: 'notifications/progress',
                    params: { progressToken: token, progress: 2, total: 2, message: 'late' }
                });
            return { content: [{ type: 'text', text: 'partial upload complete' }] };
        });
        return server;
    };
    const client = newClient();
    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const tap = tapWire(client);

    const updates: Progress[] = [];
    const result = await client.callTool({ name: 'upload', arguments: {} }, undefined, { onprogress: p => updates.push(p) });

    expect(result.content).toEqual([{ type: 'text', text: 'partial upload complete' }]);
    expect(updates).toEqual([{ progress: 1, total: 2, message: 'halfway' }]);

    const receivedBeforeLateSend = tap.received.length;
    if (!lateProgress) throw new Error('handler did not capture the late-progress sender');
    await lateProgress();
    // Sentinel on the same server→client channel: once it arrives, the late progress (had it been sent) would have arrived too.
    await server.sendToolListChanged();
    await vi.waitFor(() =>
        expect(tap.received.filter(isNotification).filter(m => m.method === 'notifications/tools/list_changed')).toHaveLength(1)
    );

    // Spec: progress notifications for the token stop once the associated request has completed.
    const lateProgressOnWire = tap.received
        .slice(receivedBeforeLateSend)
        .filter(isNotification)
        .filter(m => m.method === 'notifications/progress');
    expect(lateProgressOnWire).toEqual([]);
});

verifies('protocol:cancel:in-flight', async ({ transport, protocolVersion }: TestArgs) => {
    const handlerStarted: RequestId[] = [];
    const handlerAbortReasons: unknown[] = [];
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool(
            'long_export',
            { inputSchema: z.object({}) },
            async (_a, extra) =>
                new Promise((_resolve, reject) => {
                    handlerStarted.push(extra.requestId);
                    extra.signal.addEventListener('abort', () => {
                        handlerAbortReasons.push(extra.signal.reason);
                        reject(new Error(String(extra.signal.reason)));
                    });
                })
        );
        return s;
    };
    const client = newClient();
    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const tap = tapWire(client);

    const ac = new AbortController();
    const call = client.callTool({ name: 'long_export', arguments: {} }, undefined, { signal: ac.signal });
    call.catch(() => {});

    // Cancel only once the handler is running, so the cancellation targets a request that is genuinely in flight on the server.
    await vi.waitFor(() => expect(handlerStarted).toHaveLength(1));
    const callRequest = tap.sent.filter(isRequest).find(m => m.method === 'tools/call');
    if (!callRequest) throw new Error('tools/call request not captured');

    ac.abort(new Error('user cancelled the export'));
    await expect(call).rejects.toThrow('user cancelled the export');

    await vi.waitFor(() =>
        expect(
            tap.sent
                .filter(isNotification)
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

    expect(tap.received.filter(isResponse).filter(m => m.id === callRequest.id)).toEqual([]);
});

verifies('protocol:progress:client-to-server', async ({ transport, protocolVersion }: TestArgs) => {
    const serverUpdates: Progress[] = [];
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('summarize_report', { inputSchema: z.object({ text: z.string() }) }, async ({ text }, extra) => {
            const result = await extra.sendRequest(
                {
                    method: 'sampling/createMessage',
                    params: {
                        messages: [{ role: 'user', content: { type: 'text', text: `Summarize the following report:\n${text}` } }],
                        maxTokens: 200
                    }
                },
                CreateMessageResultSchema,
                { onprogress: p => serverUpdates.push(p) }
            );
            if (result.content.type !== 'text') throw new Error('expected text sampling content');
            return { content: [{ type: 'text', text: result.content.text }] };
        });
        return s;
    };

    const client = new Client({ name: 'c', version: '0' }, { capabilities: { sampling: {} } });
    client.setRequestHandler(CreateMessageRequestSchema, async (req, extra) => {
        const token = req.params._meta?.progressToken;
        if (token === undefined) throw new Error('expected a progressToken on the sampling request');
        await extra.sendNotification({
            method: 'notifications/progress',
            params: { progressToken: token, progress: 1, total: 2, message: 'sampling started' }
        });
        await extra.sendNotification({
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

    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

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

verifies('protocol:request-handler:override-builtin', async ({ transport, protocolVersion }: TestArgs) => {
    const makeServer = () => {
        const s = new Server({ name: 's', version: '0' }, { capabilities: {} });
        // Ping has a built-in handler; this should replace it without throwing.
        s.setRequestHandler(PingRequestSchema, () => ({ _meta: { 'e2e/overridden': true } }));
        return s;
    };

    const client = newClient();
    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    expect(() =>
        new Server({ name: 's', version: '0' }, { capabilities: {} }).setRequestHandler(PingRequestSchema, () => ({}))
    ).not.toThrow();

    const result = await client.ping();
    expect(result).toEqual({ _meta: { 'e2e/overridden': true } });
});

export async function mcpserverOnerrorReachThroughRaw({ transport, protocolVersion }: TestArgs) {
    const errors: Error[] = [];
    const makeServer = () => {
        const s = new Server({ name: 's', version: '0' }, { capabilities: {} });
        s.onerror = e => errors.push(e);
        return s;
    };
    const client = newClient();
    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const baseA = errors.length;
    const stray: JSONRPCMessage = { jsonrpc: '2.0', id: 99999, result: {} };
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
    expect(hitA!.message).toContain('99999');

    await expect(client.ping()).resolves.toBeDefined();
}

verifies('typescript:protocol:error:not-connected', async ({ transport, protocolVersion }: TestArgs) => {
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
    await using _ = await wire({ transport, protocolVersion }, makeServer, client);
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
    onmessage?: (message: JSONRPCMessage) => void;

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
        if (message.method === 'initialize') {
            this.respond(message.id, {
                protocolVersion: this.serverProtocolVersion,
                capabilities: { tools: {} },
                serverInfo: { name: 'loopback-server', version: '3.1.4' }
            });
        } else if (message.method === 'tools/list') {
            this.respond(message.id, {
                tools: [{ name: 'lookup_order', description: 'Look up an order by id', inputSchema: { type: 'object' } }]
            });
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
    const customTransport = new LoopbackTransport(protocolVersion);
    const client = newClient();
    const clientOnclose = vi.fn();
    client.onclose = clientOnclose;
    try {
        await client.connect(customTransport);

        // Protocol installed its callbacks on the consumer object before invoking start().
        expect(customTransport.callbacksPresentAtStart).toEqual({ onmessage: true, onclose: true, onerror: true });
        // The full handshake ran over the consumer transport, and its canned identity is what the client now reports.
        expect(customTransport.events).toEqual(['start', 'send:initialize', 'send:notifications/initialized']);
        expect(client.getServerCapabilities()).toEqual({ tools: {} });
        expect(client.getServerVersion()).toEqual({ name: 'loopback-server', version: '3.1.4' });

        // A post-handshake request round-trips through the consumer transport's send().
        const listed = await client.listTools();
        expect(listed.tools).toEqual([{ name: 'lookup_order', description: 'Look up an order by id', inputSchema: { type: 'object' } }]);
        expect(customTransport.clientRequests.map(m => m.method)).toEqual(['initialize', 'tools/list']);

        await client.close();

        // close() reached the consumer transport, and its onclose callback fed back into the client's close handling.
        expect(customTransport.events).toEqual(['start', 'send:initialize', 'send:notifications/initialized', 'send:tools/list', 'close']);
        expect(clientOnclose).toHaveBeenCalledTimes(1);
        expect(client.transport).toBeUndefined();
    } finally {
        await client.close();
    }
});

verifies('protocol:transport-callbacks:wrappable-after-connect', async ({ transport, protocolVersion }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('echo', { inputSchema: z.object({ text: z.string() }) }, ({ text }) => ({
            content: [{ type: 'text', text }]
        }));
        return s;
    };
    const client = newClient();
    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

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
    tx.onmessage = (message, extra) => {
        observedMessages.push(message);
        protocolOnMessage?.(message, extra);
    };
    tx.onerror = error => {
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
        .filter(isRequest)
        .filter(m => m.method === 'tools/call')
        .map(m => m.id);
    expect(callIds).toHaveLength(2);
    const observedResponsesFor = (id: RequestId) => observedMessages.filter(isJSONRPCResultResponse).filter(m => m.id === id);
    expect(observedResponsesFor(callIds[0])).toHaveLength(1);
    expect(observedResponsesFor(callIds[0])[0].result).toMatchObject({ content: [{ type: 'text', text: 'wrapped dispatch' }] });
    expect(observedResponsesFor(callIds[1])).toHaveLength(1);
    expect(observedResponsesFor(callIds[1])[0].result).toMatchObject({ content: [{ type: 'text', text: 'still wrapped' }] });
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
