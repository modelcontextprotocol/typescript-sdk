import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { CreateMessageRequestSchema, ElicitRequestSchema, InMemoryTransport } from '@modelcontextprotocol/core';

import { Client } from '../../src/client/client.js';

/**
 * Mirrors the server-side parity test: registering with the Zod-schema form must
 * route through the same per-method wrapper (result-shape validation) as the
 * method-string form.
 */
describe('Client.setRequestHandler — Zod-schema form parity', () => {
    async function setup(register: (c: Client) => void) {
        const client = new Client({ name: 't', version: '1.0' }, { capabilities: { sampling: {}, elicitation: {} } });
        register(client);
        const [ct, st] = InMemoryTransport.createLinkedPair();
        await ct.start();
        // Minimal server-side stub on ct so Client.connect's initialize handshake completes.
        ct.onmessage = m => {
            const msg = m as { id?: number; method?: string };
            if (msg.method === 'initialize') {
                void ct.send({
                    jsonrpc: '2.0',
                    id: msg.id!,
                    result: { protocolVersion: '2025-06-18', serverInfo: { name: 's', version: '1.0' }, capabilities: {} }
                });
            }
        };
        await client.connect(st);
        return { ct };
    }

    async function send(
        ct: InMemoryTransport,
        method: string,
        params: Record<string, unknown>
    ): Promise<{ result?: unknown; error?: unknown }> {
        return await new Promise(resolve => {
            ct.onmessage = m => {
                const msg = m as { id?: number; result?: unknown; error?: unknown };
                if (msg.id === 99 && ('result' in msg || 'error' in msg)) resolve(msg);
            };
            void ct.send({ jsonrpc: '2.0', id: 99, method, params });
        });
    }

    it('elicitation/create — schema form gets the same result-validation as string form', async () => {
        const invalidElicitResult = { action: 'nope' };
        const params = { mode: 'form', message: 'q', requestedSchema: { type: 'object', properties: {} } };

        const viaString = await setup(c => c.setRequestHandler('elicitation/create', () => invalidElicitResult as never));
        const viaSchema = await setup(c => c.setRequestHandler(ElicitRequestSchema, () => invalidElicitResult as never));

        const stringRes = await send(viaString.ct, 'elicitation/create', params);
        const schemaRes = await send(viaSchema.ct, 'elicitation/create', params);

        expect((stringRes.error as { message: string }).message).toContain('Invalid elicitation result');
        expect(schemaRes.error).toEqual(stringRes.error);
    });

    it('sampling/createMessage — schema form gets the same result-validation as string form', async () => {
        const invalidSamplingResult = { role: 'assistant' };
        const params = { messages: [], maxTokens: 1 };

        const viaString = await setup(c => c.setRequestHandler('sampling/createMessage', () => invalidSamplingResult as never));
        const viaSchema = await setup(c => c.setRequestHandler(CreateMessageRequestSchema, () => invalidSamplingResult as never));

        const stringRes = await send(viaString.ct, 'sampling/createMessage', params);
        const schemaRes = await send(viaSchema.ct, 'sampling/createMessage', params);

        expect((stringRes.error as { message: string }).message).toContain('Invalid');
        expect(schemaRes.error).toEqual(stringRes.error);
    });

    it('three-arg form gets the same result-validation as string form (elicitation/create)', async () => {
        const invalidElicitResult = { action: 'nope' };
        const params = { mode: 'form', message: 'q', requestedSchema: { type: 'object', properties: {} } };
        const viaThreeArg = await setup(c =>
            c.setRequestHandler('elicitation/create', z.object({ mode: z.string() }).passthrough(), () => invalidElicitResult as never)
        );
        const res = await send(viaThreeArg.ct, 'elicitation/create', params);
        expect((res.error as { message: string }).message).toContain('Invalid elicitation result');
    });

    it('three-arg form handles non-spec methods through Client', async () => {
        const { ct } = await setup(c => c.setRequestHandler('acme/echo', z.object({ msg: z.string() }), p => ({ reply: p.msg })));
        const res = await send(ct, 'acme/echo', { msg: 'hi' });
        expect(res.result).toEqual({ reply: 'hi' });
    });
});
