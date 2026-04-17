import type { JSONRPCErrorResponse, JSONRPCMessage, JSONRPCRequest, JSONRPCResultResponse } from '@modelcontextprotocol/core';
import { InMemoryTransport, isJSONRPCErrorResponse, isJSONRPCResultResponse, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/core';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type R = JSONRPCResultResponse & { result: any };
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { McpServer, ResourceTemplate } from '../src/server/mcpServer.js';

const req = (id: number, method: string, params?: Record<string, unknown>): JSONRPCRequest => ({
    jsonrpc: '2.0',
    id,
    method,
    params
});

const initReq = (id = 0): JSONRPCRequest =>
    req(id, 'initialize', {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: { elicitation: { form: {} } },
        clientInfo: { name: 't', version: '1' }
    });

async function collect(it: AsyncIterable<JSONRPCMessage>): Promise<JSONRPCMessage[]> {
    const out: JSONRPCMessage[] = [];
    for await (const m of it) out.push(m);
    return out;
}

async function lastResponse(it: AsyncIterable<JSONRPCMessage>): Promise<JSONRPCResultResponse | JSONRPCErrorResponse> {
    const all = await collect(it);
    const last = all[all.length - 1];
    if (!isJSONRPCResultResponse(last) && !isJSONRPCErrorResponse(last)) throw new Error('no terminal response');
    return last;
}

describe('McpServer.handle()', () => {
    it('responds to initialize with serverInfo and capabilities', async () => {
        const s = new McpServer({ name: 'srv', version: '1.0.0' }, { instructions: 'hi' });
        const r = (await lastResponse(s.handle(initReq(1)))) as R;
        expect(r.id).toBe(1);
        expect(r.result.serverInfo).toEqual({ name: 'srv', version: '1.0.0' });
        expect(r.result.instructions).toBe('hi');
        expect(r.result.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
    });

    it('responds to ping', async () => {
        const s = new McpServer({ name: 's', version: '1' });
        const r = (await lastResponse(s.handle(req(1, 'ping')))) as R;
        expect(r.result).toEqual({});
    });

    it('returns MethodNotFound for unknown method', async () => {
        const s = new McpServer({ name: 's', version: '1' });
        const r = (await lastResponse(s.handle(req(1, 'nope/nope' as never)))) as JSONRPCErrorResponse;
        expect(r.error.code).toBe(-32601);
    });

    it('registerTool + tools/list returns the tool', async () => {
        const s = new McpServer({ name: 's', version: '1' });
        s.registerTool('echo', { description: 'd', inputSchema: z.object({ x: z.string() }) }, async ({ x }) => ({
            content: [{ type: 'text', text: x }]
        }));
        const r = (await lastResponse(s.handle(req(1, 'tools/list')))) as R;
        expect(r.result.tools).toHaveLength(1);
        expect(r.result.tools[0].name).toBe('echo');
        expect(r.result.tools[0].inputSchema.type).toBe('object');
    });

    it('tools/call invokes handler with validated args', async () => {
        const s = new McpServer({ name: 's', version: '1' });
        s.registerTool('echo', { inputSchema: z.object({ x: z.string() }) }, async ({ x }) => ({
            content: [{ type: 'text', text: `got ${x}` }]
        }));
        const r = (await lastResponse(s.handle(req(1, 'tools/call', { name: 'echo', arguments: { x: 'hi' } })))) as R;
        expect(r.result.content[0].text).toBe('got hi');
    });

    it('tools/call with invalid args returns isError result', async () => {
        const s = new McpServer({ name: 's', version: '1' });
        s.registerTool('echo', { inputSchema: z.object({ x: z.string() }) }, async ({ x }) => ({
            content: [{ type: 'text', text: x }]
        }));
        const r = (await lastResponse(s.handle(req(1, 'tools/call', { name: 'echo', arguments: { x: 42 } })))) as R;
        expect(r.result.isError).toBe(true);
    });

    it('tools/call with unknown tool returns InvalidParams error response', async () => {
        const s = new McpServer({ name: 's', version: '1' });
        s.registerTool('a', {}, async () => ({ content: [] }));
        const r = (await lastResponse(s.handle(req(1, 'tools/call', { name: 'b', arguments: {} })))) as JSONRPCErrorResponse;
        expect(r.error.code).toBe(-32602);
        expect(r.error.message).toContain('not found');
    });

    it('handle yields notifications then a terminal response', async () => {
        const s = new McpServer({ name: 's', version: '1' });
        s.registerTool('progress', {}, async ctx => {
            await ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken: 1, progress: 0.5 } });
            await ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken: 1, progress: 1.0 } });
            return { content: [{ type: 'text', text: 'done' }] };
        });
        const msgs = await collect(s.handle(req(1, 'tools/call', { name: 'progress', arguments: {} })));
        expect(msgs).toHaveLength(3);
        expect((msgs[0] as { method: string }).method).toBe('notifications/progress');
        expect((msgs[1] as { method: string }).method).toBe('notifications/progress');
        expect(isJSONRPCResultResponse(msgs[2])).toBe(true);
    });

    it('ctx.mcpReq.elicitInput throws when no peer channel (handle without env.send)', async () => {
        const s = new McpServer({ name: 's', version: '1' });
        s.registerTool('ask', {}, async ctx => {
            await ctx.mcpReq.elicitInput({ message: 'q', requestedSchema: { type: 'object', properties: {} } });
            return { content: [] };
        });
        const r = (await lastResponse(s.handle(req(1, 'tools/call', { name: 'ask', arguments: {} })))) as R;
        expect(r.result.isError).toBe(true);
        expect(r.result.content[0].text).toContain('MRTR-native');
    });

    it('ctx.mcpReq.elicitInput resolves when env.send provided', async () => {
        const s = new McpServer({ name: 's', version: '1' });
        s.registerTool('ask', {}, async ctx => {
            const er = await ctx.mcpReq.elicitInput({ message: 'q', requestedSchema: { type: 'object', properties: {} } });
            return { content: [{ type: 'text', text: er.action }] };
        });
        const r = (await lastResponse(
            s.handle(req(1, 'tools/call', { name: 'ask', arguments: {} }), {
                send: async () => ({ action: 'accept', content: {} })
            })
        )) as R;
        expect(r.result.content[0].text).toBe('accept');
    });

    it('registerResource + resources/list + resources/read', async () => {
        const s = new McpServer({ name: 's', version: '1' });
        s.registerResource('cfg', 'config://app', { mimeType: 'text/plain' }, async uri => ({
            contents: [{ uri: uri.href, text: 'v' }]
        }));
        const list = (await lastResponse(s.handle(req(1, 'resources/list')))) as R;
        expect(list.result.resources[0].uri).toBe('config://app');
        const read = (await lastResponse(s.handle(req(2, 'resources/read', { uri: 'config://app' })))) as R;
        expect(read.result.contents[0].text).toBe('v');
    });

    it('registerResource with template + resources/read matches', async () => {
        const s = new McpServer({ name: 's', version: '1' });
        s.registerResource('user', new ResourceTemplate('users://{id}', { list: undefined }), {}, async (uri, { id }) => ({
            contents: [{ uri: uri.href, text: String(id) }]
        }));
        const r = (await lastResponse(s.handle(req(1, 'resources/read', { uri: 'users://abc' })))) as R;
        expect(r.result.contents[0].text).toBe('abc');
    });

    it('registerPrompt + prompts/list + prompts/get', async () => {
        const s = new McpServer({ name: 's', version: '1' });
        s.registerPrompt('p', { argsSchema: z.object({ q: z.string() }) }, ({ q }) => ({
            messages: [{ role: 'user', content: { type: 'text', text: q } }]
        }));
        const list = (await lastResponse(s.handle(req(1, 'prompts/list')))) as R;
        expect(list.result.prompts[0].name).toBe('p');
        const get = (await lastResponse(s.handle(req(2, 'prompts/get', { name: 'p', arguments: { q: 'hi' } })))) as R;
        expect(get.result.messages[0].content.text).toBe('hi');
    });

    it('RegisteredTool.disable hides from tools/list', async () => {
        const s = new McpServer({ name: 's', version: '1' });
        const t = s.registerTool('x', {}, async () => ({ content: [] }));
        t.disable();
        const r = (await lastResponse(s.handle(req(1, 'tools/list')))) as R;
        expect(r.result.tools).toHaveLength(0);
    });

    it('handleHttp parses body and returns JSON response', async () => {
        const s = new McpServer({ name: 's', version: '1' });
        const httpReq = new Request('http://x/mcp', {
            method: 'POST',
            body: JSON.stringify(req(1, 'ping')),
            headers: { 'content-type': 'application/json' }
        });
        const res = await s.handleHttp(httpReq);
        expect(res.status).toBe(200);
        const body = (await res.json()) as R;
        expect(body.id).toBe(1);
        expect(body.result).toEqual({});
    });

    it('handleHttp returns 400 on parse error', async () => {
        const s = new McpServer({ name: 's', version: '1' });
        const res = await s.handleHttp(new Request('http://x/mcp', { method: 'POST', body: '{broken' }));
        expect(res.status).toBe(400);
    });

    it('handleHttp returns 202 for notification-only body', async () => {
        const s = new McpServer({ name: 's', version: '1' });
        const res = await s.handleHttp(
            new Request('http://x/mcp', {
                method: 'POST',
                body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
            })
        );
        expect(res.status).toBe(202);
    });
});

describe('McpServer compat / .server / connect()', () => {
    it('.server === this', () => {
        const s = new McpServer({ name: 's', version: '1' });
        expect(s.server).toBe(s);
    });

    it('isConnected reflects connect/close', async () => {
        const s = new McpServer({ name: 's', version: '1' });
        expect(s.isConnected()).toBe(false);
        const [a, b] = InMemoryTransport.createLinkedPair();
        await s.connect(a);
        expect(s.isConnected()).toBe(true);
        expect(s.transport).toBe(a);
        void b;
        await s.close();
        expect(s.isConnected()).toBe(false);
    });

    it('connect() then peer can send tools/list', async () => {
        const s = new McpServer({ name: 's', version: '1' });
        s.registerTool('t', {}, async () => ({ content: [] }));
        const [serverPipe, clientPipe] = InMemoryTransport.createLinkedPair();
        await s.connect(serverPipe);
        await clientPipe.start();

        const responses: JSONRPCMessage[] = [];
        clientPipe.onmessage = m => responses.push(m);

        await clientPipe.send(initReq(0));
        await clientPipe.send(req(1, 'tools/list'));
        await new Promise(r => setTimeout(r, 10));

        const listResp = responses.find(m => isJSONRPCResultResponse(m) && m.id === 1) as R;
        expect(listResp.result.tools[0].name).toBe('t');
    });

    it('connect() twice replaces the active driver (v1 multi-transport pattern)', async () => {
        const s = new McpServer({ name: 's', version: '1' });
        const [a] = InMemoryTransport.createLinkedPair();
        await s.connect(a);
        const [c] = InMemoryTransport.createLinkedPair();
        await expect(s.connect(c)).resolves.toBeUndefined();
        expect(s.transport).toBe(c);
    });

    it('elicitInput() instance method throws NotConnected when no driver', async () => {
        const s = new McpServer({ name: 's', version: '1' });
        await expect(
            s.elicitInput({ message: 'q', requestedSchema: { type: 'object', properties: {} } })
        ).rejects.toThrow(/not connected/i);
    });

    it('registerCapabilities throws after connect', async () => {
        const s = new McpServer({ name: 's', version: '1' });
        const [a] = InMemoryTransport.createLinkedPair();
        await s.connect(a);
        expect(() => s.registerCapabilities({ logging: {} })).toThrow();
    });

    it('initialize via handle() populates getClientCapabilities', async () => {
        const s = new McpServer({ name: 's', version: '1' });
        await lastResponse(s.handle(initReq(0)));
        expect(s.getClientCapabilities()?.elicitation?.form).toBeDefined();
        expect(s.getClientVersion()?.name).toBe('t');
    });
});
