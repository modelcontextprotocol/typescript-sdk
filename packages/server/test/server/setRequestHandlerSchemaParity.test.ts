import { describe, expect, it } from 'vitest';

import { CallToolRequestSchema, InMemoryTransport } from '@modelcontextprotocol/core';

import { Server } from '../../src/server/server.js';

/**
 * Regression test: setRequestHandler(CallToolRequestSchema, h) and
 * setRequestHandler('tools/call', h) must apply the same per-method
 * wrapping (task-result validation when params.task is set).
 */
describe('Server.setRequestHandler — Zod-schema form parity', () => {
    async function setup(register: (s: Server) => void) {
        const server = new Server({ name: 't', version: '1.0' }, { capabilities: { tools: {} } });
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

        expect(stringRes.error).toBeDefined();
        expect(schemaRes.error).toEqual(stringRes.error);
    });
});
