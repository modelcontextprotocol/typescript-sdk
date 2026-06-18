/**
 * createMcpHandler — entry-handled `subscriptions/listen` router.
 *
 * Covers ack-first (the acknowledged notification is the first frame),
 * subscription-id stamping (the listen request's JSON-RPC id verbatim),
 * per-stream filtering (un-requested types provably never delivered),
 * notify sugar, capacity guard, factory non-consultation, and teardown.
 */
import {
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    PROTOCOL_VERSION_META_KEY,
    SUBSCRIPTION_ID_META_KEY
} from '@modelcontextprotocol/core';
import { describe, expect, it } from 'vitest';

import { createMcpHandler } from '../../src/server/createMcpHandler.js';
import { McpServer } from '../../src/server/mcp.js';

const ENVELOPE = {
    [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
    [CLIENT_INFO_META_KEY]: { name: 'listen-test-client', version: '1.0.0' },
    [CLIENT_CAPABILITIES_META_KEY]: {}
};

function listenRequest(id: string | number, filter: Record<string, unknown>): Request {
    return new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id,
            method: 'subscriptions/listen',
            params: { _meta: ENVELOPE, notifications: filter }
        })
    });
}

/** Read N SSE `event: message` payloads from a streaming response, then cancel. */
async function readMessages(response: Response, n: number): Promise<unknown[]> {
    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const messages: unknown[] = [];
    while (messages.length < n) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const dataLine = frame.split('\n').find(l => l.startsWith('data: '));
            if (dataLine) messages.push(JSON.parse(dataLine.slice(6)));
        }
    }
    await reader.cancel();
    return messages;
}

function trivialFactory(): () => McpServer {
    return () => new McpServer({ name: 'listen-test-server', version: '1.0.0' });
}

describe('createMcpHandler — subscriptions/listen', () => {
    it('serves listen at the entry without consulting the factory', async () => {
        let factoryCalls = 0;
        const handler = createMcpHandler(
            () => {
                factoryCalls++;
                return new McpServer({ name: 's', version: '1' });
            },
            { keepAliveMs: 0 }
        );
        const response = await handler.fetch(listenRequest(1, { toolsListChanged: true }));
        expect(response.status).toBe(200);
        const [ack] = await readMessages(response, 1);
        expect(factoryCalls).toBe(0);
        expect((ack as { method: string }).method).toBe('notifications/subscriptions/acknowledged');
        await handler.close();
    });

    it('ack is the first frame, stamped with the listen id verbatim, carrying the honored subset', async () => {
        const handler = createMcpHandler(trivialFactory(), { keepAliveMs: 0 });
        const response = await handler.fetch(listenRequest('sub-42', { toolsListChanged: true, promptsListChanged: false }));
        const [ack] = await readMessages(response, 1);
        expect(ack).toEqual({
            jsonrpc: '2.0',
            method: 'notifications/subscriptions/acknowledged',
            params: { _meta: { [SUBSCRIPTION_ID_META_KEY]: 'sub-42' }, notifications: { toolsListChanged: true } }
        });
        await handler.close();
    });

    it('delivers only opted-in change types, each stamped with the subscription id', async () => {
        const handler = createMcpHandler(trivialFactory(), { keepAliveMs: 0 });
        const response = await handler.fetch(
            listenRequest(7, { toolsListChanged: true, resourceSubscriptions: ['file:///a'] })
        );
        // Publish before reading: a stream that did NOT opt in to prompts must
        // never see the prompts notification (provably-never-delivered).
        handler.notify.promptsChanged();
        handler.notify.toolsChanged();
        handler.notify.resourceUpdated('file:///b');
        handler.notify.resourceUpdated('file:///a');
        const messages = (await readMessages(response, 3)) as { method: string; params: Record<string, unknown> }[];
        expect(messages.map(m => m.method)).toEqual([
            'notifications/subscriptions/acknowledged',
            'notifications/tools/list_changed',
            'notifications/resources/updated'
        ]);
        expect(messages[2]!.params).toEqual({ _meta: { [SUBSCRIPTION_ID_META_KEY]: 7 }, uri: 'file:///a' });
        for (const m of messages) {
            expect((m.params['_meta'] as Record<string, unknown>)[SUBSCRIPTION_ID_META_KEY]).toBe(7);
        }
        await handler.close();
    });

    it("refuses pre-ack with -32603 'Subscription limit reached' when at capacity", async () => {
        const handler = createMcpHandler(trivialFactory(), { keepAliveMs: 0, maxSubscriptions: 1 });
        const first = await handler.fetch(listenRequest(1, { toolsListChanged: true }));
        expect(first.headers.get('Content-Type')).toBe('text/event-stream');
        const second = await handler.fetch(listenRequest(2, { toolsListChanged: true }));
        expect(second.headers.get('Content-Type')).toContain('application/json');
        const body = (await second.json()) as { error: { code: number; message: string }; id: unknown };
        expect(body.error.code).toBe(-32_603);
        expect(body.error.message).toBe('Subscription limit reached');
        expect(body.id).toBe(2);
        await first.body!.cancel();
        await handler.close();
    });

    it('handler.close() tears down every open listen stream (HTTP teardown is stream close)', async () => {
        const handler = createMcpHandler(trivialFactory(), { keepAliveMs: 0 });
        const response = await handler.fetch(listenRequest(1, { toolsListChanged: true }));
        const reader = response.body!.getReader();
        // First frame is the ack.
        await reader.read();
        await handler.close();
        // Stream-close termination: the read loop ends with no result frame.
        let sawResult = false;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = new TextDecoder().decode(value);
            if (text.includes('"result"')) sawResult = true;
        }
        expect(sawResult).toBe(false);
    });

    it('legacy-classified listen never reaches the entry listen router (no ack delivered)', async () => {
        const handler = createMcpHandler(trivialFactory(), { keepAliveMs: 0 });
        // No envelope claim → classified legacy → dispatched through the
        // stateless fallback's Server, where `subscriptions/listen` is not in
        // the 2025 registry → −32601 in-band (the legacy transport may stream
        // it as a single SSE frame).
        const response = await handler.fetch(
            new Request('http://localhost/mcp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'subscriptions/listen',
                    params: { notifications: { toolsListChanged: true } }
                })
            })
        );
        const text = await response.text();
        expect(text).not.toContain('notifications/subscriptions/acknowledged');
        expect(text).toContain('-32601');
        await handler.close();
    });
});
