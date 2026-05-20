import type { JSONRPCMessage, JSONRPCRequest, Transport } from '@modelcontextprotocol/core';
import { DRAFT_PROTOCOL_VERSION, JSONRPC_VERSION, META_KEYS, SdkError } from '@modelcontextprotocol/core';
import { describe, expect, it } from 'vitest';

import { LegacyClient as Client } from '../../src/client/legacyClient.js';

/** Minimal transport with a scriptable sendAndReceive. */
function mockTransport(handler: (req: JSONRPCRequest) => AsyncIterable<JSONRPCMessage>): Transport {
    return {
        start: async () => {},
        close: async () => {},
        send: async () => {},
        sendAndReceive: req => handler({ jsonrpc: JSONRPC_VERSION, id: 0, ...req } as JSONRPCRequest)
    };
}

/** Forces the client into stateless mode without going through connect(). */
function statelessClient(transport: Transport): Client {
    const c = new Client({ name: 'c', version: '1' }, { capabilities: { elicitation: {} } });
    Object.assign(c as object, {
        _isStateless: true,
        _negotiatedProtocolVersion: DRAFT_PROTOCOL_VERSION,
        _serverCapabilities: { tools: {}, prompts: {} },
        _transport: transport
    });
    return c;
}

async function* once(m: JSONRPCMessage): AsyncIterable<JSONRPCMessage> {
    yield m;
}

describe('Client._send (stateless)', () => {
    it('routes via sendAndReceive when stateless', async () => {
        let seenMeta: unknown;
        const t = mockTransport(req => {
            seenMeta = req.params?._meta;
            return once({ jsonrpc: JSONRPC_VERSION, id: req.id, result: { tools: [] } });
        });
        const c = statelessClient(t);
        const r = await c.listTools();
        expect(r.tools).toEqual([]);
        expect((seenMeta as Record<string, unknown>)[META_KEYS.protocolVersion]).toBe(DRAFT_PROTOCOL_VERSION);
        expect((seenMeta as Record<string, unknown>)[META_KEYS.clientInfo]).toEqual({ name: 'c', version: '1' });
    });

    it('falls back to Protocol.request when not stateless', async () => {
        const c = new Client({ name: 'c', version: '1' });
        // Not stateless, no transport — request() will throw NotConnected.
        await expect(c.getPrompt({ name: 'x' })).rejects.toThrow();
    });

    it('MRTR: dispatches input requests via dispatcher.dispatch (middleware runs)', async () => {
        let round = 0;
        const t = mockTransport(req => {
            round++;
            if (round === 1) {
                return once({
                    jsonrpc: JSONRPC_VERSION,
                    id: req.id,
                    result: {
                        resultType: 'input_required',
                        inputRequests: {
                            e0: {
                                method: 'elicitation/create',
                                params: { message: 'q', mode: 'form', requestedSchema: { type: 'object', properties: {} } }
                            }
                        }
                    }
                });
            }
            const ir = (req.params as Record<string, unknown>).inputResponses as Record<string, unknown>;
            return once({
                jsonrpc: JSONRPC_VERSION,
                id: req.id,
                result: { tools: [{ name: JSON.stringify(ir.e0), inputSchema: { type: 'object' } }] }
            });
        });
        const c = statelessClient(t);
        c.setRequestHandler('elicitation/create', async () => ({ action: 'accept' as const }));
        const r = await c.listTools();
        expect(round).toBe(2);
        expect(JSON.parse((r.tools[0] as { name: string }).name)).toEqual({ action: 'accept' });
    });

    it('MRTR: threads requestState into next round', async () => {
        let round = 0;
        let seenState: unknown;
        const t = mockTransport(req => {
            round++;
            if (round === 1) {
                return once({
                    jsonrpc: JSONRPC_VERSION,
                    id: req.id,
                    result: { resultType: 'input_required', inputRequests: {}, requestState: 'opaque-state' }
                });
            }
            seenState = (req.params as Record<string, unknown>).requestState;
            return once({ jsonrpc: JSONRPC_VERSION, id: req.id, result: { tools: [] } });
        });
        const c = statelessClient(t);
        await c.listTools();
        expect(seenState).toBe('opaque-state');
    });

    it('MRTR: throws after MRTR_MAX_ROUNDS', async () => {
        const t = mockTransport(req =>
            once({ jsonrpc: JSONRPC_VERSION, id: req.id, result: { resultType: 'input_required', inputRequests: {} } })
        );
        const c = statelessClient(t);
        await expect(c.listTools()).rejects.toThrow(SdkError);
    });

    it('propagates abort signal', async () => {
        const ac = new AbortController();
        const t = mockTransport(req => {
            ac.abort();
            return once({ jsonrpc: JSONRPC_VERSION, id: req.id, result: { resultType: 'input_required', inputRequests: {} } });
        });
        const c = statelessClient(t);
        await expect(c.listTools(undefined, { signal: ac.signal })).rejects.toThrow();
    });

    it('routes notifications/progress with matching token to onprogress', async () => {
        const t = mockTransport(req => {
            const token = (req.params?._meta as Record<string, unknown>).progressToken;
            return (async function* () {
                yield {
                    jsonrpc: JSONRPC_VERSION,
                    method: 'notifications/progress',
                    params: { progressToken: token, progress: 50, total: 100 }
                } as JSONRPCMessage;
                yield { jsonrpc: JSONRPC_VERSION, id: req.id, result: { tools: [] } };
            })();
        });
        const c = statelessClient(t);
        const seen: number[] = [];
        await c.listTools(undefined, { onprogress: p => seen.push(p.progress) });
        expect(seen).toEqual([50]);
    });

    it('throws ProtocolError on JSON-RPC error response', async () => {
        const t = mockTransport(req => once({ jsonrpc: JSONRPC_VERSION, id: req.id, error: { code: -32_601, message: 'nope' } }));
        const c = statelessClient(t);
        await expect(c.listTools()).rejects.toMatchObject({ code: -32_601 });
    });
});

describe('Client.subscribe', () => {
    it('throws when not stateless', async () => {
        const c = new Client({ name: 'c', version: '1' });
        const it = c.subscribe({ toolsListChanged: true });
        await expect(it.next()).rejects.toThrow(SdkError);
    });

    it('yields notifications from listen stream', async () => {
        const t = mockTransport(() =>
            (async function* () {
                yield {
                    jsonrpc: JSONRPC_VERSION,
                    method: 'notifications/subscriptions/acknowledged',
                    params: { notifications: { toolsListChanged: true } }
                } as JSONRPCMessage;
                yield { jsonrpc: JSONRPC_VERSION, method: 'notifications/tools/list_changed', params: {} } as JSONRPCMessage;
            })()
        );
        const c = statelessClient(t);
        const seen: string[] = [];
        for await (const n of c.subscribe({ toolsListChanged: true })) {
            seen.push(n.method);
        }
        expect(seen).toEqual(['notifications/subscriptions/acknowledged', 'notifications/tools/list_changed']);
    });
});

describe('Client.connect auto-probe (SEP-2575)', () => {
    function discoverable(handler: (req: JSONRPCRequest) => AsyncIterable<JSONRPCMessage>): Transport {
        const t = mockTransport(handler);
        // Route legacy `initialize` (sent via Protocol.request → transport.send)
        // back through onmessage so the fallback path can complete in-process.
        t.send = async m => {
            if ('method' in m && m.method === 'initialize') {
                queueMicrotask(() =>
                    t.onmessage?.({
                        jsonrpc: JSONRPC_VERSION,
                        id: (m as JSONRPCRequest).id,
                        result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 's', version: '1' } }
                    })
                );
            } else if ('method' in m && m.method === 'notifications/initialized') {
                // ignore
            }
        };
        return t;
    }

    it('discover success → stateless mode, skips initialize', async () => {
        const seen: string[] = [];
        const t = discoverable(req => {
            seen.push(req.method);
            return once({
                jsonrpc: JSONRPC_VERSION,
                id: req.id,
                result: {
                    supportedVersions: [DRAFT_PROTOCOL_VERSION],
                    capabilities: { tools: {} },
                    serverInfo: { name: 's', version: '2' }
                }
            });
        });
        const c = new Client({ name: 'c', version: '1' });
        await c.connect(t);
        expect(seen).toEqual(['server/discover']);
        expect((c as unknown as { _isStateless: boolean })._isStateless).toBe(true);
        expect(c.getServerCapabilities()).toEqual({ tools: {} });
        expect(c.getServerVersion()).toEqual({ name: 's', version: '2' });
    });

    it('discover MethodNotFound → falls back to legacy initialize', async () => {
        const seen: string[] = [];
        const t = discoverable(req => {
            seen.push(req.method);
            return once({ jsonrpc: JSONRPC_VERSION, id: req.id, error: { code: -32_601, message: 'unknown method' } });
        });
        const c = new Client({ name: 'c', version: '1' });
        await c.connect(t);
        expect(seen).toEqual(['server/discover']);
        expect((c as unknown as { _isStateless: boolean })._isStateless).toBe(false);
        expect(c.getServerVersion()).toEqual({ name: 's', version: '1' });
    });

    it('no sendAndReceive → goes straight to legacy initialize', async () => {
        const t: Transport = {
            start: async () => {},
            close: async () => {},
            send: async m => {
                if ('method' in m && m.method === 'initialize') {
                    queueMicrotask(() =>
                        t.onmessage?.({
                            jsonrpc: JSONRPC_VERSION,
                            id: (m as JSONRPCRequest).id,
                            result: {
                                protocolVersion: '2025-11-25',
                                capabilities: {},
                                serverInfo: { name: 's', version: '1' }
                            }
                        })
                    );
                }
            }
        };
        const c = new Client({ name: 'c', version: '1' });
        await c.connect(t);
        expect((c as unknown as { _isStateless: boolean })._isStateless).toBe(false);
        expect(c.getServerVersion()?.name).toBe('s');
    });
});
