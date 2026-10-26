import type { JSONRPCMessage } from '@modelcontextprotocol/core-internal';
import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/core-internal';
import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';
import type { McpServerOptions } from '../../src/index';
import { McpServer } from '../../src/index';

type ToolResult = { content?: Array<{ text?: string }>; isError?: boolean };

const ok = () => ({ content: [{ type: 'text' as const, text: 'ok' }] });

// Connects a peer to a server with three tools; `call` sends a tools/call and resolves with the result of its response.
async function connect(options?: McpServerOptions) {
    const server = new McpServer({ name: 'test', version: '1.0.0' }, options);
    const handlers = { t: vi.fn(ok), objects: vi.fn(ok), plain: vi.fn(ok) };
    server.registerTool('t', { inputSchema: { items: z.array(z.string()) } }, handlers.t);
    server.registerTool(
        'objects',
        { inputSchema: { items: z.array(z.object({ a: z.number(), b: z.number().optional() })) } },
        handlers.objects
    );
    server.registerTool('plain', {}, handlers.plain);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const waiters = new Map<unknown, (message: JSONRPCMessage) => void>();
    clientTransport.onmessage = message => waiters.get((message as { id?: unknown }).id)?.(message);
    await server.connect(serverTransport);
    await clientTransport.start();

    let id = 0;
    const request = (method: string, params: Record<string, unknown>) =>
        new Promise<JSONRPCMessage>(resolve => {
            waiters.set(++id, resolve);
            void clientTransport.send({ jsonrpc: '2.0', id, method, params });
        });
    await request('initialize', {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'c', version: '1.0.0' }
    });
    await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    const call = async (name: string, args: Record<string, unknown>): Promise<ToolResult | undefined> =>
        ((await request('tools/call', { name, arguments: args })) as { result?: ToolResult }).result;
    return { call, handlers };
}

async function callArrayTool(items: unknown, options?: McpServerOptions): Promise<ToolResult | undefined> {
    const { call } = await connect(options);
    return call('t', { items });
}

describe('maxToolInputElements', () => {
    it('accepts a large array when no limit is set', async () => {
        const result = await callArrayTool(Array(60_000).fill('x'));
        expect(result?.isError).toBeFalsy();
        expect(result?.content?.[0]?.text).toBe('ok');
    });

    it('refuses arguments past a configured limit', async () => {
        const result = await callArrayTool(Array(60_000).fill('x'), { maxToolInputElements: 1_000 });
        expect(result?.isError).toBe(true);
        expect(result?.content?.[0]?.text).toContain('more than the maximum');
    });

    it('accepts arguments within a configured limit', async () => {
        const result = await callArrayTool(Array(1_000).fill('x'), { maxToolInputElements: 2_000 });
        expect(result?.isError).toBeFalsy();
        expect(result?.content?.[0]?.text).toBe('ok');
    });

    it('treats Infinity as no limit', async () => {
        const result = await callArrayTool(Array(60_000).fill('x'), { maxToolInputElements: Infinity });
        expect(result?.isError).toBeFalsy();
        expect(result?.content?.[0]?.text).toBe('ok');
    });

    it('rejects a limit that is not a number of at least 1 at construction', () => {
        expect(() => new McpServer({ name: 't', version: '1.0.0' }, { maxToolInputElements: Number.NaN })).toThrow();
        expect(() => new McpServer({ name: 't', version: '1.0.0' }, { maxToolInputElements: 0 })).toThrow();
        expect(() => new McpServer({ name: 't', version: '1.0.0' }, { maxToolInputElements: 0.5 })).toThrow();
        expect(() => new McpServer({ name: 't', version: '1.0.0' }, { maxToolInputElements: -1 })).toThrow();
    });

    it('counts members of nested objects together with array elements', async () => {
        const { call } = await connect({ maxToolInputElements: 12 });
        const full = { a: 1, b: 2 };

        // 1 top-level member + 4 array elements + 7 object members = 12
        const atLimit = await call('objects', { items: [full, full, full, { a: 1 }] });
        expect(atLimit?.isError).toBeFalsy();
        expect(atLimit?.content?.[0]?.text).toBe('ok');

        // 1 top-level member + 4 array elements + 8 object members = 13
        const pastLimit = await call('objects', { items: [full, full, full, full] });
        expect(pastLimit?.isError).toBe(true);
        expect(pastLimit?.content?.[0]?.text).toContain('more than the maximum');
    });

    it('answers an ordinary call after a refused call on the same server', async () => {
        const { call } = await connect({ maxToolInputElements: 1_000 });

        const refused = await call('t', { items: Array(60_000).fill('x') });
        expect(refused?.isError).toBe(true);

        const answered = await call('t', { items: ['x'] });
        expect(answered?.isError).toBeFalsy();
        expect(answered?.content?.[0]?.text).toBe('ok');
    });

    it('does not invoke the handler for a refused call', async () => {
        const { call, handlers } = await connect({ maxToolInputElements: 1_000 });

        await call('t', { items: ['x'] });
        expect(handlers.t).toHaveBeenCalledTimes(1);

        const refused = await call('t', { items: Array(60_000).fill('x') });
        expect(refused?.isError).toBe(true);
        expect(handlers.t).toHaveBeenCalledTimes(1);
    });

    it('applies the limit to a tool registered without an input schema', async () => {
        const items = Array(20).fill('x');

        const limited = await connect({ maxToolInputElements: 10 });
        const refused = await limited.call('plain', { items });
        expect(refused?.isError).toBe(true);
        expect(refused?.content?.[0]?.text).toContain('more than the maximum');
        expect(limited.handlers.plain).not.toHaveBeenCalled();

        const unlimited = await connect();
        const answered = await unlimited.call('plain', { items });
        expect(answered?.isError).toBeFalsy();
        expect(answered?.content?.[0]?.text).toBe('ok');
        expect(unlimited.handlers.plain).toHaveBeenCalledTimes(1);
    });
});
