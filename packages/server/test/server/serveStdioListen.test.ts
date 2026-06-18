/**
 * `serveStdio` — entry-handled `subscriptions/listen` on the stdio entry.
 *
 * Covers ack-first on the single channel, subscription-id stamping, the
 * pinned instance's send*ListChanged() feeding the connection's listen
 * router (era-gated; legacy unchanged), inbound cancel hardening, and the
 * stdio teardown MUST (one notifications/cancelled per subscription id).
 */
import type { JSONRPCMessage, JSONRPCNotification, JSONRPCRequest, Transport } from '@modelcontextprotocol/core';
import {
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    InMemoryTransport,
    PROTOCOL_VERSION_META_KEY,
    SUBSCRIPTION_ID_META_KEY
} from '@modelcontextprotocol/core';
import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';

import { McpServer } from '../../src/server/mcp.js';
import { serveStdio } from '../../src/server/serveStdio.js';

const ENVELOPE = {
    [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
    [CLIENT_INFO_META_KEY]: { name: 'stdio-listen-test', version: '1' },
    [CLIENT_CAPABILITIES_META_KEY]: {}
};

function listenReq(id: number | string, filter: Record<string, unknown>): JSONRPCRequest {
    return { jsonrpc: '2.0', id, method: 'subscriptions/listen', params: { _meta: ENVELOPE, notifications: filter } };
}

async function bootModern(options?: { maxSubscriptions?: number }) {
    const [peerTx, wireTx] = InMemoryTransport.createLinkedPair();
    const inbound: JSONRPCMessage[] = [];
    peerTx.onmessage = m => inbound.push(m);
    await peerTx.start();

    let server!: McpServer;
    const handle = serveStdio(
        () => {
            server = new McpServer({ name: 's', version: '1' });
            server.registerTool('a', { inputSchema: z.object({}) }, async () => ({ content: [] }));
            return server;
        },
        { transport: wireTx as Transport, ...options }
    );
    // Pin modern with a tools/list (any non-discover enveloped request).
    await peerTx.send({ jsonrpc: '2.0', id: 'pin', method: 'tools/list', params: { _meta: ENVELOPE } });
    await new Promise(r => setTimeout(r, 10));
    inbound.length = 0;
    const flush = () => new Promise(r => setTimeout(r, 10));
    const send = (m: JSONRPCRequest | JSONRPCNotification) => peerTx.send(m);
    return { handle, server: () => server, inbound, send, flush };
}

describe('serveStdio — subscriptions/listen', () => {
    it('ack is the first message after a listen request, stamped with the listen id verbatim', async () => {
        const { handle, inbound, send, flush } = await bootModern();
        await send(listenReq(7, { toolsListChanged: true }));
        await flush();
        expect(inbound).toHaveLength(1);
        expect(inbound[0]).toEqual({
            jsonrpc: '2.0',
            method: 'notifications/subscriptions/acknowledged',
            params: { _meta: { [SUBSCRIPTION_ID_META_KEY]: 7 }, notifications: { toolsListChanged: true } }
        });
        await handle.close();
    });

    it("the pinned instance's sendToolListChanged() reaches only opted-in subscriptions, stamped per stream", async () => {
        const { handle, server, inbound, send, flush } = await bootModern();
        await send(listenReq(1, { toolsListChanged: true }));
        await send(listenReq(2, { promptsListChanged: true }));
        await flush();
        inbound.length = 0;
        // Mutate registration → McpServer fires sendToolListChanged().
        server().registerTool('b', { inputSchema: z.object({}) }, async () => ({ content: [] }));
        await flush();
        expect(inbound).toHaveLength(1);
        const note = inbound[0] as JSONRPCNotification;
        expect(note.method).toBe('notifications/tools/list_changed');
        expect((note.params as { _meta: Record<string, unknown> })._meta[SUBSCRIPTION_ID_META_KEY]).toBe(1);
        await handle.close();
    });

    it('drops change notifications no subscription opted in to (modern era never delivers unsolicited)', async () => {
        const { handle, server, inbound, send, flush } = await bootModern();
        await send(listenReq(1, { promptsListChanged: true }));
        await flush();
        inbound.length = 0;
        server().sendToolListChanged();
        await flush();
        expect(inbound).toEqual([]);
        await handle.close();
    });

    it('inbound notifications/cancelled tears the subscription down; nothing further delivered (post-cancel hardening)', async () => {
        const { handle, server, inbound, send, flush } = await bootModern();
        await send(listenReq(5, { toolsListChanged: true }));
        await flush();
        inbound.length = 0;
        await send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 5 } });
        await flush();
        server().sendToolListChanged();
        await flush();
        expect(inbound).toEqual([]);
        await handle.close();
    });

    it('handle.close() emits one notifications/cancelled per active subscription id (stdio teardown MUST)', async () => {
        const { handle, inbound, send, flush } = await bootModern();
        await send(listenReq('s1', { toolsListChanged: true }));
        await send(listenReq('s2', { promptsListChanged: true }));
        await flush();
        inbound.length = 0;
        await handle.close();
        const cancelled = inbound.filter(m => (m as JSONRPCNotification).method === 'notifications/cancelled');
        expect(cancelled.map(m => (m as JSONRPCNotification).params)).toEqual([{ requestId: 's1' }, { requestId: 's2' }]);
        // No JSON-RPC result for the listen ids — termination is the cancelled notification only.
        expect(inbound.some(m => 'result' in m)).toBe(false);
    });

    it('refuses pre-ack with -32603 when at capacity', async () => {
        const { handle, inbound, send, flush } = await bootModern({ maxSubscriptions: 1 });
        await send(listenReq(1, { toolsListChanged: true }));
        await send(listenReq(2, { toolsListChanged: true }));
        await flush();
        const err = inbound.find(m => 'error' in m) as { id: unknown; error: { code: number; message: string } } | undefined;
        expect(err?.id).toBe(2);
        expect(err?.error.code).toBe(-32_603);
        expect(err?.error.message).toBe('Subscription limit reached');
        await handle.close();
    });

    it("legacy-era pinned connection passes change notifications through unchanged (2025 unsolicited delivery)", async () => {
        const [peerTx, wireTx] = InMemoryTransport.createLinkedPair();
        const inbound: JSONRPCMessage[] = [];
        peerTx.onmessage = m => inbound.push(m);
        await peerTx.start();
        let server!: McpServer;
        const handle = serveStdio(
            () => {
                server = new McpServer({ name: 's', version: '1' });
                server.registerTool('a', { inputSchema: z.object({}) }, async () => ({ content: [] }));
                return server;
            },
            { transport: wireTx as Transport }
        );
        // Legacy opening.
        await peerTx.send({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'c', version: '1' } }
        });
        await new Promise(r => setTimeout(r, 10));
        await peerTx.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        await new Promise(r => setTimeout(r, 10));
        inbound.length = 0;
        server.sendToolListChanged();
        await new Promise(r => setTimeout(r, 10));
        // 2025 unsolicited delivery: passed straight through, NO subscription-id stamp.
        expect(inbound).toHaveLength(1);
        const note = inbound[0] as JSONRPCNotification;
        expect(note.method).toBe('notifications/tools/list_changed');
        expect((note.params as { _meta?: unknown } | undefined)?._meta).toBeUndefined();
        await handle.close();
    });
});
