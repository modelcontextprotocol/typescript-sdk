/**
 * `subscriptions/listen` (SEP-1865, protocol revision 2026-07-28) through the
 * public surface: ack-first, subscription-id stamping, per-stream filtering,
 * the listChanged auto-open bridge, and the F-12 legacy steer.
 *
 * The 2026-era cells host `createMcpHandler` themselves (the test publishes
 * via `handler.notify.*`); the legacy cell runs on the standard arms.
 */
import { Client, SdkError, SdkErrorCode, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler, McpServer, SUBSCRIPTION_ID_META_KEY } from '@modelcontextprotocol/server';
import { expect } from 'vitest';
import { z } from 'zod/v4';

import { modernEnvelopeMeta, wire } from '../helpers/index.js';
import { verifies } from '../helpers/verifies.js';
import type { TestArgs } from '../types.js';

function makeServer() {
    const server = new McpServer({ name: 'subs-e2e', version: '1' });
    server.registerTool('greet', { inputSchema: z.object({}) }, async () => ({ content: [] }));
    return server;
}

async function hostListen() {
    const handler = createMcpHandler(() => makeServer(), { legacy: 'reject', keepAliveMs: 0 });
    const url = new URL('http://in-process/mcp');
    const fetch = (u: URL | string, init?: RequestInit) => handler.fetch(new Request(u, init));
    const client = new Client({ name: 'subs-e2e-client', version: '1' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(new StreamableHTTPClientTransport(url, { fetch }));
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    return {
        client,
        handler,
        fetch,
        url,
        [Symbol.asyncDispose]: () => Promise.all([client.close(), handler.close()]).then(() => {})
    };
}

verifies('subscriptions:listen:ack-first-stamped', async () => {
    const handler = createMcpHandler(() => makeServer(), { legacy: 'reject', keepAliveMs: 0 });
    const response = await handler.fetch(
        new Request('http://in-process/mcp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 'sub-1',
                method: 'subscriptions/listen',
                params: { _meta: modernEnvelopeMeta(), notifications: { toolsListChanged: true } }
            })
        })
    );
    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    const reader = response.body!.getReader();
    const { value } = await reader.read();
    const frame = new TextDecoder().decode(value);
    const ack = JSON.parse(frame.slice(frame.indexOf('data: ') + 6, frame.indexOf('\n\n'))) as {
        method: string;
        params: { _meta: Record<string, unknown>; notifications: unknown };
    };
    expect(ack.method).toBe('notifications/subscriptions/acknowledged');
    expect(ack.params._meta[SUBSCRIPTION_ID_META_KEY]).toBe('sub-1');
    expect(ack.params.notifications).toEqual({ toolsListChanged: true });
    await reader.cancel();
    await handler.close();
});

verifies('subscriptions:listen:per-stream-filter', async () => {
    await using h = await hostListen();
    const seen: string[] = [];
    h.client.setNotificationHandler('notifications/tools/list_changed', () => void seen.push('tools'));
    h.client.setNotificationHandler('notifications/prompts/list_changed', () => void seen.push('prompts'));
    const sub = await h.client.listen({ toolsListChanged: true });
    h.handler.notify.promptsChanged();
    h.handler.notify.toolsChanged();
    await new Promise(r => setTimeout(r, 30));
    // The un-requested type was provably never delivered.
    expect(seen).toEqual(['tools']);
    await sub.close();
});

verifies('typescript:subscriptions:listChanged-auto-open-modern', async () => {
    const handler = createMcpHandler(() => makeServer(), { legacy: 'reject', keepAliveMs: 0 });
    const fetch = (u: URL | string, init?: RequestInit) => handler.fetch(new Request(u, init));
    let count = 0;
    let done!: () => void;
    const finished = new Promise<void>(r => {
        done = r;
    });
    const client = new Client(
        { name: 'subs-e2e-client', version: '1' },
        {
            versionNegotiation: { mode: 'auto' },
            listChanged: { tools: { autoRefresh: false, onChanged: () => (++count >= 1 ? done() : undefined) } }
        }
    );
    await client.connect(new StreamableHTTPClientTransport(new URL('http://in-process/mcp'), { fetch }));
    expect(client.autoOpenedSubscription?.honoredFilter).toEqual({ toolsListChanged: true });
    handler.notify.toolsChanged();
    await finished;
    expect(count).toBe(1);
    await client.autoOpenedSubscription!.close();
    await client.close();
    await handler.close();
});

verifies('typescript:subscriptions:listen:legacy-era-steer', async ({ transport }: TestArgs) => {
    const client = new Client({ name: 'c', version: '0' });
    await using _ = await wire(transport, makeServer, client);
    const error = await client.listen({ toolsListChanged: true }).catch(error_ => error_ as SdkError);
    expect(error).toBeInstanceOf(SdkError);
    expect((error as SdkError).code).toBe(SdkErrorCode.MethodNotSupportedByProtocolVersion);
    expect((error as SdkError).message).toContain('resources/subscribe');
});

verifies('subscriptions:listen:capacity-guard', async () => {
    const handler = createMcpHandler(() => makeServer(), { legacy: 'reject', keepAliveMs: 0, maxSubscriptions: 1 });
    const post = (id: number) =>
        handler.fetch(
            new Request('http://in-process/mcp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id,
                    method: 'subscriptions/listen',
                    params: { _meta: modernEnvelopeMeta(), notifications: {} }
                })
            })
        );
    const first = await post(1);
    expect(first.headers.get('Content-Type')).toBe('text/event-stream');
    const second = await post(2);
    expect(second.headers.get('Content-Type')).toContain('application/json');
    const body = (await second.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32_603);
    expect(body.error.message).toBe('Subscription limit reached');
    await first.body!.cancel();
    await handler.close();
});
