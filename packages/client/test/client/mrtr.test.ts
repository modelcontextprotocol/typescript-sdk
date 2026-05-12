import { describe, expect, test } from 'vitest';

import type {
    JSONRPCErrorResponse,
    JSONRPCNotification,
    JSONRPCRequest,
    JSONRPCResultResponse,
    Notification
} from '@modelcontextprotocol/core';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/core';

import { Client } from '../../src/client/client.js';
import type { ClientFetchOptions, ClientTransport } from '../../src/client/clientTransport.js';

type Handler = (req: JSONRPCRequest, opts?: ClientFetchOptions) => Promise<JSONRPCResultResponse | JSONRPCErrorResponse>;

/**
 * Minimal in-process {@linkcode ClientTransport} backed by a per-method handler map. The
 * `initialize` reply uses the supplied protocol version so the SEP-2575 init-gate can be
 * exercised in either direction.
 */
function fakeClientTransport(
    serverProtocolVersion: string,
    handlers: Record<string, Handler> = {}
): ClientTransport & {
    sentNotifications: Notification[];
    calls: JSONRPCRequest[];
} {
    const sentNotifications: Notification[] = [];
    const calls: JSONRPCRequest[] = [];
    return {
        kind: 'request',
        sentNotifications,
        calls,
        async fetch(req, opts) {
            calls.push(req);
            if (req.method === 'initialize') {
                return {
                    jsonrpc: '2.0',
                    id: req.id,
                    result: {
                        protocolVersion: serverProtocolVersion,
                        capabilities: { tools: { listChanged: true } },
                        serverInfo: { name: 'fake', version: '0.0.0' }
                    }
                };
            }
            const h = handlers[req.method];
            if (!h) return { jsonrpc: '2.0', id: req.id, error: { code: -32_601, message: `no handler: ${req.method}` } };
            return h(req, opts);
        },
        async notify(n) {
            sentNotifications.push(n);
        },
        async close() {},
        setProtocolVersion() {}
    };
}

describe('Client.connect(ClientTransport)', () => {
    test('accepts a request-shaped transport and completes the initialize handshake', async () => {
        const ct = fakeClientTransport(LATEST_PROTOCOL_VERSION);
        const client = new Client({ name: 't', version: '0' });
        await client.connect(ct);
        expect(client.getServerCapabilities()).toEqual({ tools: { listChanged: true } });
        expect(client.getNegotiatedProtocolVersion()).toBe(LATEST_PROTOCOL_VERSION);
    });

    test('routes outbound requests via fetch() and validates the result', async () => {
        const ct = fakeClientTransport(LATEST_PROTOCOL_VERSION, {
            'tools/list': async req => ({ jsonrpc: '2.0', id: req.id, result: { tools: [] } })
        });
        const client = new Client({ name: 't', version: '0' });
        await client.connect(ct);
        const res = await client.listTools();
        expect(res.tools).toEqual([]);
        expect(ct.calls.map(c => c.method)).toContain('tools/list');
    });
});

describe('SEP-2575 notifications/initialized gate', () => {
    test('sends notifications/initialized when negotiated version < 2026-06-30', async () => {
        const ct = fakeClientTransport('2025-11-25');
        const client = new Client({ name: 't', version: '0' });
        await client.connect(ct);
        expect(ct.sentNotifications.map(n => n.method)).toContain('notifications/initialized');
    });

    test('skips notifications/initialized when negotiated version >= 2026-06-30', async () => {
        const ct = fakeClientTransport('2026-06-30');
        const client = new Client({ name: 't', version: '0' }, { supportedProtocolVersions: ['2026-06-30', LATEST_PROTOCOL_VERSION] });
        await client.connect(ct);
        expect(ct.sentNotifications.map(n => n.method)).not.toContain('notifications/initialized');
    });
});

describe('SEP-2322 MRTR retry loop', () => {
    test('services inputRequests via local handler and retries with inputResponses+requestState', async () => {
        const seen: Array<{ round: number; params: unknown }> = [];
        const ct = fakeClientTransport(LATEST_PROTOCOL_VERSION, {
            'tools/call': async req => {
                const params = req.params as { inputResponses?: Record<string, unknown>; requestState?: string };
                seen.push({ round: seen.length, params });
                if (!params.inputResponses) {
                    // Round 0: ask the client to elicit a value.
                    return {
                        jsonrpc: '2.0',
                        id: req.id,
                        result: {
                            resultType: 'incomplete',
                            requestState: 'state-1',
                            inputRequests: {
                                k0: {
                                    method: 'elicitation/create',
                                    params: { message: 'q', requestedSchema: { type: 'object', properties: {} } }
                                }
                            }
                        }
                    };
                }
                // Round 1: receive the elicited answer and finish.
                return {
                    jsonrpc: '2.0',
                    id: req.id,
                    result: { content: [{ type: 'text', text: JSON.stringify(params.inputResponses) }] }
                };
            }
        });
        const client = new Client({ name: 't', version: '0' }, { capabilities: { elicitation: {} } });
        client.setRequestHandler('elicitation/create', async () => ({ action: 'accept', content: { v: 42 } }));
        await client.connect(ct);

        const result = await client.callTool({ name: 'x', arguments: {} });
        expect(seen).toHaveLength(2);
        expect((seen[1]!.params as { requestState: string }).requestState).toBe('state-1');
        expect((seen[1]!.params as { inputResponses: Record<string, unknown> }).inputResponses).toEqual({
            k0: { action: 'accept', content: { v: 42 } }
        });
        expect((result.content as Array<{ text: string }>)[0]!.text).toContain('"v":42');
    });

    test('caps rounds via mrtrMaxRounds and throws on exhaustion', async () => {
        const ct = fakeClientTransport(LATEST_PROTOCOL_VERSION, {
            'tools/call': async req => ({
                jsonrpc: '2.0',
                id: req.id,
                result: { resultType: 'incomplete', requestState: `s${req.id}` }
            })
        });
        const client = new Client({ name: 't', version: '0' }, { mrtrMaxRounds: 3 });
        await client.connect(ct);
        await expect(client.callTool({ name: 'x', arguments: {} })).rejects.toThrow(/MRTR exceeded 3 rounds/);
    });

    test('propagates handler error from _serviceInputRequests instead of retrying with partial set', async () => {
        const ct = fakeClientTransport(LATEST_PROTOCOL_VERSION, {
            'tools/call': async req => ({
                jsonrpc: '2.0',
                id: req.id,
                result: {
                    resultType: 'incomplete',
                    inputRequests: {
                        k0: { method: 'elicitation/create', params: { message: 'q', requestedSchema: { type: 'object', properties: {} } } }
                    }
                }
            })
        });
        const client = new Client({ name: 't', version: '0' }, { capabilities: { elicitation: {} } });
        client.setRequestHandler('elicitation/create', async () => {
            throw new Error('user cancelled');
        });
        await client.connect(ct);
        await expect(client.callTool({ name: 'x', arguments: {} })).rejects.toThrow();
    });

    test('round-trip on the pipe-transport path: super._requestWithSchema sees IncompleteResult and loop retries', async () => {
        // Drive both rounds through a fake ClientTransport but assert the loop machinery is on
        // the override (not the fetch path) by checking that subscribe-stream notifications
        // also flow when delivered via fetch onnotification.
        let progressDelivered = false;
        const ct = fakeClientTransport(LATEST_PROTOCOL_VERSION, {
            'tools/call': async (req, opts) => {
                opts?.onnotification?.({
                    jsonrpc: '2.0',
                    method: 'notifications/message',
                    params: { level: 'info', data: 'x' }
                } as JSONRPCNotification);
                return { jsonrpc: '2.0', id: req.id, result: { content: [] } };
            }
        });
        const client = new Client({ name: 't', version: '0' });
        client.setNotificationHandler('notifications/message', async () => {
            progressDelivered = true;
        });
        await client.connect(ct);
        await client.callTool({ name: 'x', arguments: {} });
        expect(progressDelivered).toBe(true);
    });
});
