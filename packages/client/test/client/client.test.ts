import type {
    CallToolResult,
    CreateTaskResult,
    JSONRPCErrorResponse,
    JSONRPCNotification,
    JSONRPCRequest,
    JSONRPCResultResponse,
    Notification
} from '@modelcontextprotocol/core';
import { InMemoryTransport, LATEST_PROTOCOL_VERSION, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/core';
import { describe, expect, it, vi } from 'vitest';

import type { ClientFetchOptions, ClientTransport } from '../../src/client/clientTransport.js';
import { isChannelTransport } from '../../src/client/clientTransport.js';
import { Client } from '../../src/client/client.js';

type FetchResp = JSONRPCResultResponse | JSONRPCErrorResponse;

function mockTransport(handler: (req: JSONRPCRequest, opts?: ClientFetchOptions) => Promise<FetchResp> | FetchResp): {
    ct: ClientTransport;
    sent: JSONRPCRequest[];
    notified: Notification[];
} {
    const sent: JSONRPCRequest[] = [];
    const notified: Notification[] = [];
    const ct: ClientTransport = {
        async fetch(req, opts) {
            sent.push(req);
            return handler(req, opts);
        },
        async notify(n) {
            notified.push(n);
        },
        async close() {}
    };
    return { ct, sent, notified };
}

const ok = (id: JSONRPCRequest['id'], result: unknown): JSONRPCResultResponse => ({ jsonrpc: '2.0', id, result }) as JSONRPCResultResponse;
const err = (id: JSONRPCRequest['id'], code: number, message: string): JSONRPCErrorResponse => ({
    jsonrpc: '2.0',
    id,
    error: { code, message }
});

const initResult = (caps: Record<string, unknown> = { tools: { listChanged: true } }) => ({
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: caps,
    serverInfo: { name: 's', version: '1.0.0' }
});

describe('Client (V2)', () => {
    describe('connect via ClientTransport', () => {
        it('falls back to initialize when server/discover is MethodNotFound, populates server caps', async () => {
            const { ct, sent, notified } = mockTransport(req => {
                if (req.method === 'server/discover') return err(req.id, ProtocolErrorCode.MethodNotFound, 'nope');
                if (req.method === 'initialize') return ok(req.id, initResult());
                return err(req.id, ProtocolErrorCode.MethodNotFound, 'unexpected');
            });
            const c = new Client({ name: 'c', version: '1' });
            await c.connect(ct);
            expect(sent[0]?.method).toBe('server/discover');
            expect(sent.find(r => r.method === 'initialize')).toBeDefined();
            expect(c.getServerCapabilities()?.tools).toBeDefined();
            expect(c.getServerVersion()?.name).toBe('s');
            expect(notified.find(n => n.method === 'notifications/initialized')).toBeDefined();
        });

        it('uses server/discover result directly when supported (2026-06)', async () => {
            const { ct, sent } = mockTransport(req => {
                if (req.method === 'server/discover') {
                    return ok(req.id, { capabilities: { tools: {} }, serverInfo: { name: 'd', version: '2' } });
                }
                throw new Error('should not reach');
            });
            const c = new Client({ name: 'c', version: '1' });
            await c.connect(ct);
            expect(sent.some(r => r.method === 'initialize')).toBe(false);
            expect(c.getServerVersion()?.name).toBe('d');
        });

        it('isChannelTransport correctly distinguishes the two shapes', () => {
            const [a] = InMemoryTransport.createLinkedPair();
            const { ct } = mockTransport(r => ok(r.id, {}));
            expect(isChannelTransport(a)).toBe(true);
            expect(isChannelTransport(ct)).toBe(false);
        });
    });

    describe('typed RPC sugar', () => {
        async function connected(handler: (req: JSONRPCRequest, opts?: ClientFetchOptions) => FetchResp | Promise<FetchResp>) {
            const m = mockTransport((req, opts) => {
                if (req.method === 'server/discover')
                    return ok(req.id, { capabilities: { tools: {}, prompts: {}, resources: {} }, serverInfo: { name: 's', version: '1' } });
                return handler(req, opts);
            });
            const c = new Client({ name: 'c', version: '1' });
            await c.connect(m.ct);
            return { c, ...m };
        }

        it('callTool returns the result', async () => {
            const { c } = await connected(r =>
                r.method === 'tools/call' ? ok(r.id, { content: [{ type: 'text', text: 'hi' }] }) : err(r.id, -32601, 'nope')
            );
            const result = (await c.callTool({ name: 'x', arguments: {} })) as CallToolResult;
            expect(result.content[0]).toEqual({ type: 'text', text: 'hi' });
        });

        it('listTools caches output validators and callTool enforces them', async () => {
            const tools = [
                { name: 'typed', inputSchema: { type: 'object' }, outputSchema: { type: 'object', properties: { n: { type: 'number' } } } }
            ];
            const { c } = await connected(r => {
                if (r.method === 'tools/list') return ok(r.id, { tools });
                if (r.method === 'tools/call') return ok(r.id, { content: [], structuredContent: { n: 'not-a-number' } });
                return err(r.id, -32601, 'nope');
            });
            await c.listTools();
            await expect(c.callTool({ name: 'typed', arguments: {} })).rejects.toThrow(ProtocolError);
        });

        it('callTool rejects when tool with outputSchema returns no structuredContent', async () => {
            const { c } = await connected(r => {
                if (r.method === 'tools/list') {
                    return ok(r.id, { tools: [{ name: 't', inputSchema: { type: 'object' }, outputSchema: { type: 'object' } }] });
                }
                if (r.method === 'tools/call') return ok(r.id, { content: [] });
                return err(r.id, -32601, 'nope');
            });
            await c.listTools();
            await expect(c.callTool({ name: 't', arguments: {} })).rejects.toThrow(/structured content/);
        });

        it('list* return empty when capability missing and not strict', async () => {
            const { ct } = mockTransport(r =>
                r.method === 'server/discover'
                    ? ok(r.id, { capabilities: {}, serverInfo: { name: 's', version: '1' } })
                    : err(r.id, -32601, 'nope')
            );
            const c = new Client({ name: 'c', version: '1' });
            await c.connect(ct);
            expect(await c.listTools()).toEqual({ tools: [] });
            expect(await c.listPrompts()).toEqual({ prompts: [] });
            expect(await c.listResources()).toEqual({ resources: [] });
        });

        it('throws ProtocolError on JSON-RPC error response', async () => {
            const { c } = await connected(r => err(r.id, ProtocolErrorCode.InvalidParams, 'bad'));
            await expect(c.ping()).rejects.toBeInstanceOf(ProtocolError);
        });

        it('passes onprogress through to transport', async () => {
            const seen: unknown[] = [];
            const { c } = await connected(async (r, opts) => {
                opts?.onprogress?.({ progress: 1, total: 2 });
                return ok(r.id, { content: [] });
            });
            await c.callTool({ name: 'x', arguments: {} }, { onprogress: (p: unknown) => seen.push(p) });
            expect(seen).toEqual([{ progress: 1, total: 2 }]);
        });
    });

    describe('MRTR loop', () => {
        it('re-sends with inputResponses when server returns input_required, resolves on complete', async () => {
            let round = 0;
            const elicitArgs = {
                method: 'elicitation/create',
                params: { message: 'q', requestedSchema: { type: 'object', properties: {} } }
            };
            const { ct, sent } = mockTransport(r => {
                if (r.method === 'server/discover')
                    return ok(r.id, { capabilities: { tools: {} }, serverInfo: { name: 's', version: '1' } });
                if (r.method === 'tools/call') {
                    round++;
                    if (round === 1) return ok(r.id, { ResultType: 'input_required', InputRequests: { ask: elicitArgs } });
                    return ok(r.id, { content: [{ type: 'text', text: 'done' }] });
                }
                return err(r.id, -32601, 'nope');
            });
            const c = new Client({ name: 'c', version: '1' }, { capabilities: { elicitation: {} } });
            c.setRequestHandler('elicitation/create', async () => ({ action: 'accept', content: { x: 1 } }));
            await c.connect(ct);
            const result = (await c.callTool({ name: 't', arguments: {} })) as CallToolResult;
            expect(result.content[0]).toEqual({ type: 'text', text: 'done' });
            expect(round).toBe(2);
            const second = sent.filter(r => r.method === 'tools/call')[1];
            const meta = second?.params?._meta as Record<string, unknown> | undefined;
            const irs = meta?.['modelcontextprotocol.io/mrtr/inputResponses'] as Record<string, unknown> | undefined;
            expect(irs?.ask).toEqual({ action: 'accept', content: { x: 1 } });
        });

        it('throws if no handler is registered for an InputRequest method', async () => {
            const { ct } = mockTransport(r => {
                if (r.method === 'server/discover')
                    return ok(r.id, { capabilities: { tools: {} }, serverInfo: { name: 's', version: '1' } });
                if (r.method === 'tools/call') {
                    return ok(r.id, { ResultType: 'input_required', InputRequests: { s: { method: 'sampling/createMessage' } } });
                }
                return err(r.id, -32601, 'nope');
            });
            const c = new Client({ name: 'c', version: '1' });
            await c.connect(ct);
            await expect(c.callTool({ name: 't', arguments: {} })).rejects.toThrow();
        });

        it('caps rounds at mrtrMaxRounds', async () => {
            const { ct } = mockTransport(r => {
                if (r.method === 'server/discover')
                    return ok(r.id, { capabilities: { tools: {} }, serverInfo: { name: 's', version: '1' } });
                return ok(r.id, { ResultType: 'input_required', InputRequests: { p: { method: 'ping' } } });
            });
            const c = new Client({ name: 'c', version: '1' }, { mrtrMaxRounds: 3 });
            await c.connect(ct);
            await expect(c.callTool({ name: 't', arguments: {} })).rejects.toThrow(/MRTR exceeded 3/);
        });
    });

    describe('connect via legacy pipe Transport (2025-11 compat)', () => {
        it('runs initialize handshake over an InMemoryTransport pair', async () => {
            const [clientPipe, serverPipe] = InMemoryTransport.createLinkedPair();
            // Minimal hand-rolled server end of the pipe.
            serverPipe.onmessage = msg => {
                if ('method' in msg && msg.method === 'initialize' && 'id' in msg) {
                    void serverPipe.send({ jsonrpc: '2.0', id: msg.id, result: initResult() } as JSONRPCResultResponse);
                }
                if ('method' in msg && msg.method === 'tools/list' && 'id' in msg) {
                    void serverPipe.send({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } } as JSONRPCResultResponse);
                }
            };
            await serverPipe.start();
            const c = new Client({ name: 'c', version: '1' });
            await c.connect(clientPipe);
            expect(c.getServerCapabilities()?.tools).toBeDefined();
            expect(c.getNegotiatedProtocolVersion()).toBe(LATEST_PROTOCOL_VERSION);
            const r = await c.listTools();
            expect(r.tools).toEqual([]);
            await c.close();
        });

        it('skips re-init when transport already has a sessionId', async () => {
            const [clientPipe, serverPipe] = InMemoryTransport.createLinkedPair();
            (clientPipe as { sessionId?: string }).sessionId = 'existing';
            const seen: string[] = [];
            serverPipe.onmessage = msg => {
                if ('method' in msg) seen.push(msg.method);
            };
            await serverPipe.start();
            const c = new Client({ name: 'c', version: '1' });
            await c.connect(clientPipe);
            expect(seen).not.toContain('initialize');
        });
    });

    describe('handler registration', () => {
        it('setRequestHandler is used for MRTR servicing and pipe-mode dispatch alike', async () => {
            const handler = vi.fn(async () => ({ roots: [] }));
            const c = new Client({ name: 'c', version: '1' }, { capabilities: { roots: {} } });
            c.setRequestHandler('roots/list', handler);
            // Exercise via MRTR path:
            const { ct } = mockTransport(r => {
                if (r.method === 'server/discover')
                    return ok(r.id, { capabilities: { tools: {} }, serverInfo: { name: 's', version: '1' } });
                if (r.method === 'tools/call') {
                    return ok(r.id, { ResultType: 'input_required', InputRequests: { r: { method: 'roots/list' } } });
                }
                return ok(r.id, { content: [] });
            });
            await c.connect(ct);
            // First call hits input_required → roots/list handler, second resolves.
            // We don't await because the second mock branch never returns complete; instead
            // verify the handler was invoked at least once via the MRTR servicing path.
            const p = c.callTool({ name: 't', arguments: {} }).catch(() => {});
            await new Promise(r => setTimeout(r, 0));
            expect(handler).toHaveBeenCalled();
            void p;
        });

        it('routes per-request notifications from transport to local notification handlers', async () => {
            const got: JSONRPCNotification[] = [];
            const { ct } = mockTransport(async (r, opts) => {
                if (r.method === 'server/discover')
                    return ok(r.id, { capabilities: { tools: {} }, serverInfo: { name: 's', version: '1' } });
                opts?.onnotification?.({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'x' } });
                return ok(r.id, { content: [] });
            });
            const c = new Client({ name: 'c', version: '1' });
            c.setNotificationHandler('notifications/message', (n: unknown) => void got.push(n as JSONRPCNotification));
            await c.connect(ct);
            await c.callTool({ name: 't', arguments: {} });
            expect(got).toHaveLength(1);
        });
    });

    describe('tasks (SEP-1686 / SEP-2557)', () => {
        async function connected(handler: (req: JSONRPCRequest) => FetchResp | Promise<FetchResp>) {
            const m = mockTransport(req => {
                if (req.method === 'server/discover')
                    return ok(req.id, {
                        capabilities: { tools: {}, tasks: { tools: { call: true } } },
                        serverInfo: { name: 's', version: '1' }
                    });
                return handler(req);
            });
            const c = new Client({ name: 'c', version: '1' });
            await c.connect(m.ct);
            return { c, ...m };
        }

        it('experimental.tasks getter exists and is lazily constructed once', async () => {
            const { c } = await connected(r => ok(r.id, {}));
            const a = c.experimental.tasks;
            const b = c.experimental.tasks;
            expect(a).toBe(b);
            expect(typeof a.callToolStream).toBe('function');
        });

        it('callTool throws with guidance when server returns a task without awaitTask (v1-compat surface)', async () => {
            const taskResult = { task: { taskId: 't-1', status: 'working', createdAt: '2026-01-01T00:00:00Z' } };
            const { c } = await connected(r => (r.method === 'tools/call' ? ok(r.id, taskResult) : err(r.id, -32601, '')));
            await expect(c.callTool({ name: 'slow', arguments: {} })).rejects.toThrow(/returned a task.*awaitTask/);
        });

        const taskBody = (overrides: Record<string, unknown> = {}) => ({
            taskId: 't-2',
            status: 'working',
            ttl: null,
            createdAt: '2026-01-01T00:00:00Z',
            lastUpdatedAt: '2026-01-01T00:00:00Z',
            ...overrides
        });

        it('callTool with awaitTask polls tasks/get then tasks/result', async () => {
            let getCalls = 0;
            const { c, sent } = await connected(r => {
                if (r.method === 'tools/call') return ok(r.id, { task: taskBody() });
                if (r.method === 'tasks/get') {
                    getCalls++;
                    return ok(r.id, taskBody({ status: getCalls === 1 ? 'working' : 'completed' }));
                }
                if (r.method === 'tasks/result') return ok(r.id, { content: [{ type: 'text', text: 'done' }] });
                return err(r.id, -32601, '');
            });
            const result = (await c.callTool({ name: 'slow', arguments: {} }, { awaitTask: true })) as CallToolResult;
            expect(result.content[0]).toEqual({ type: 'text', text: 'done' });
            expect(getCalls).toBe(2);
            expect(sent.some(r => r.method === 'tasks/result')).toBe(true);
        });

        it('getTask / listTasks / cancelTask call the right methods', async () => {
            const { c, sent } = await connected(r => {
                if (r.method === 'tasks/get') return ok(r.id, taskBody({ taskId: 'x', status: 'completed' }));
                if (r.method === 'tasks/list') return ok(r.id, { tasks: [] });
                if (r.method === 'tasks/cancel') return ok(r.id, taskBody({ taskId: 'x', status: 'cancelled' }));
                return err(r.id, -32601, '');
            });
            await c.getTask({ taskId: 'x' });
            await c.listTasks();
            await c.cancelTask({ taskId: 'x' });
            expect(sent.map(r => r.method).filter(m => m.startsWith('tasks/'))).toEqual(['tasks/get', 'tasks/list', 'tasks/cancel']);
        });

        it('taskManager is available on the request-shaped path (Client-owned)', async () => {
            const { c } = await connected(r => ok(r.id, {}));
            expect(c.taskManager).toBeDefined();
        });
    });
});
