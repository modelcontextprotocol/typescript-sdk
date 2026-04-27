import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { CallToolRequestSchema, InMemoryTransport } from '@modelcontextprotocol/core';

import { Server } from '../../src/server/server.js';

/**
 * Regression test: setRequestHandler(CallToolRequestSchema, h) and
 * setRequestHandler('tools/call', h) must apply the same per-method
 * wrapping (task-result validation when params.task is set).
 */
describe('Server.setRequestHandler — Zod-schema form parity', () => {
    async function setup(register: (s: Server) => void) {
        const server = new Server(
            { name: 't', version: '1.0' },
            { capabilities: { tools: {}, tasks: { requests: { tools: { call: {} } } } } }
        );
        register(server);
        const [ct, st] = InMemoryTransport.createLinkedPair();
        await server.connect(st);
        await ct.start();
        return { ct };
    }

    async function callToolWithTask(ct: InMemoryTransport): Promise<{ result?: unknown; error?: unknown }> {
        return await new Promise(resolve => {
            ct.onmessage = m => {
                const msg = m as { result?: unknown; error?: unknown };
                if ('result' in msg || 'error' in msg) resolve(msg);
            };
            ct.send({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: { name: 'x', arguments: {}, task: { ttl: 1000 } }
            });
        });
    }

    it('schema form gets the same task-result validation as string form', async () => {
        const invalidTaskResult = { content: [{ type: 'text' as const, text: 'not a task result' }] };

        const viaString = await setup(s => s.setRequestHandler('tools/call', () => invalidTaskResult));
        const viaSchema = await setup(s => s.setRequestHandler(CallToolRequestSchema, () => invalidTaskResult));

        const stringRes = await callToolWithTask(viaString.ct);
        const schemaRes = await callToolWithTask(viaSchema.ct);

        expect((stringRes.error as { message: string }).message).toContain('Invalid task creation result');
        expect(schemaRes.error).toEqual(stringRes.error);
    });

    it('method-string form handler receives spec-parsed request (not raw JSONRPCRequest)', async () => {
        let received: unknown;
        const { ct } = await setup(s =>
            s.setRequestHandler('tools/call', req => {
                received = req;
                return { content: [{ type: 'text' as const, text: 'ok' }] };
            })
        );
        await new Promise<void>(resolve => {
            ct.onmessage = m => {
                if ('result' in (m as object) || 'error' in (m as object)) resolve();
            };
            ct.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x', arguments: {} } });
        });
        expect(received).not.toHaveProperty('jsonrpc');
        expect(received).not.toHaveProperty('id');
        expect(received).toMatchObject({ method: 'tools/call', params: { name: 'x', arguments: {} } });
    });

    it('schema form handles non-spec methods through Server (no spec-schema crash)', async () => {
        const Echo = z.object({ method: z.literal('acme/echo'), params: z.object({ msg: z.string() }) });
        const { ct } = await setup(s => s.setRequestHandler(Echo, req => ({ reply: req.params.msg })));
        const res = await new Promise<{ result?: unknown; error?: unknown }>(resolve => {
            ct.onmessage = m => {
                const msg = m as { result?: unknown; error?: unknown };
                if ('result' in msg || 'error' in msg) resolve(msg);
            };
            ct.send({ jsonrpc: '2.0', id: 1, method: 'acme/echo', params: { msg: 'hi' } });
        });
        expect(res.result).toEqual({ reply: 'hi' });
    });
});
