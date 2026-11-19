import type { JSONRPCRequest } from '@modelcontextprotocol/core-internal';
import { encodeMcpParamValue } from '@modelcontextprotocol/core-internal';
import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';

import { EventsExtension } from '../../../src/ext/events/index';
import { serve } from './harness';

const P = z.object({ n: z.number() });
const INPUT = z.object({ region: z.string().meta({ 'x-mcp-header': 'Region' }), severity: z.string().optional() });
const NAME = 'incident.created';
const HOOK = 'https://hooks.example.com/mcp';
const SECRET = `whsec_${btoa('x'.repeat(32))}`;

let nextId = 1;

function request(method: string, params: Record<string, unknown>): JSONRPCRequest {
    return { jsonrpc: '2.0', id: nextId++, method, params };
}

function pollRequest(args: Record<string, unknown>): JSONRPCRequest {
    return request('events/poll', { name: NAME, arguments: args, cursor: null });
}

// One event type with a Region header annotation, served beside a tool with the same annotation.
function served() {
    const events = new EventsExtension();
    events.registerEvent(NAME, { inputSchema: INPUT, payloadSchema: P, check: () => ({ events: [], cursor: 'h1' }) });
    return serve(events, {
        setup: mcp => mcp.registerTool('route', { inputSchema: INPUT }, async () => ({ content: [] }))
    });
}

interface Reply {
    result?: Record<string, unknown>;
    error?: { code: number; data?: { mismatch?: { header?: string } } };
}

describe('Mcp-Param headers on events requests', () => {
    it('rejects a poll whose Mcp-Param-Region is missing', async () => {
        const { post } = served();
        const res = await post(pollRequest({ region: 'us-west1' }));
        expect(res.status).toBe(400);
        const reply = (await res.json()) as Reply;
        expect(reply.error?.code).toBe(-32_020);
        expect(reply.error?.data?.mismatch?.header).toBe('Mcp-Param-Region');
    });

    it('accepts a matching header', async () => {
        const { post } = served();
        const res = await post(pollRequest({ region: 'us-west1', severity: 'high' }), { headers: { 'Mcp-Param-Region': 'us-west1' } });
        expect(res.status).toBe(200);
        expect(((await res.json()) as Reply).result).toMatchObject({ events: [], cursor: 'h1' });
    });

    it('accepts a non-ASCII value in the base64 sentinel (Review Focus 4)', async () => {
        const { post } = served();
        const header = encodeMcpParamValue('zürich');
        expect(header).toMatch(/^=\?base64\?.+\?=$/);
        const res = await post(pollRequest({ region: 'zürich' }), { headers: { 'Mcp-Param-Region': header } });
        expect(res.status).toBe(200);
        expect(((await res.json()) as Reply).result).toMatchObject({ cursor: 'h1' });
    });

    it.each([
        ['events/stream', {}],
        ['events/subscribe', { delivery: { mode: 'webhook', url: HOOK, secret: SECRET } }],
        ['events/unsubscribe', { delivery: { url: HOOK } }]
    ])('rejects a mismatch on %s too', async (method, extra) => {
        const { post } = served();
        // Ends the stream an unvalidated events/stream would open.
        const controller = new AbortController();
        try {
            const res = await post(request(method, { name: NAME, arguments: { region: 'us-west1' }, ...extra }), {
                headers: { 'Mcp-Param-Region': 'eu-west1' },
                signal: controller.signal
            });
            expect(res.status).toBe(400);
            expect(((await res.json()) as Reply).error?.code).toBe(-32_020);
        } finally {
            controller.abort();
        }
    });

    it('leaves tools/call validation unchanged', async () => {
        const { post } = served();
        const call = request('tools/call', { name: 'route', arguments: { region: 'us-west1' } });
        const res = await post(call, { headers: { 'Mcp-Param-Region': 'eu-west1' } });
        expect(res.status).toBe(400);
        expect(((await res.json()) as Reply).error?.code).toBe(-32_020);
    });
});
