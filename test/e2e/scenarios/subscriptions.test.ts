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

/**
 * A modern in-process host with a tool, a prompt, and a resource registered so
 * the entry advertises listChanged for all three kinds (the listen ack honors a
 * filter only for kinds the server advertises).
 */
async function hostListenAllKinds() {
    const factory = () => {
        const server = new McpServer({ name: 'subs-e2e', version: '1' });
        server.registerTool('greet', { inputSchema: z.object({}) }, async () => ({ content: [] }));
        server.registerPrompt('hello', { description: 'p' }, async () => ({ messages: [] }));
        server.registerResource('r', 'file:///r', {}, async uri => ({ contents: [{ uri: uri.href, text: 'r' }] }));
        return server;
    };
    const handler = createMcpHandler(factory, { legacy: 'reject', keepAliveMs: 0 });
    const fetch = (u: URL | string, init?: RequestInit) => handler.fetch(new Request(u, init));
    const client = new Client({ name: 'subs-e2e-client', version: '1' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(new StreamableHTTPClientTransport(new URL('http://in-process/mcp'), { fetch }));
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    return {
        client,
        handler,
        factory,
        fetch,
        [Symbol.asyncDispose]: () => Promise.all([client.close(), handler.close()]).then(() => {})
    };
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
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json, text/event-stream',
                'mcp-method': 'subscriptions/listen'
            },
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

verifies('subscriptions:listen:graceful-close', async () => {
    // Hosted directly so the test owns handler.close(); `await using` of
    // hostListen() would close on dispose and obscure the assertion.
    const handler = createMcpHandler(() => makeServer(), { legacy: 'reject', keepAliveMs: 0 });
    const fetch = (u: URL | string, init?: RequestInit) => handler.fetch(new Request(u, init));
    const client = new Client({ name: 'subs-e2e-client', version: '1' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(new StreamableHTTPClientTransport(new URL('http://in-process/mcp'), { fetch }));
    const sub = await client.listen({ toolsListChanged: true });
    // Server-side graceful close: the entry's listen router emits the empty
    // SubscriptionsListenResult as the final SSE frame, then closes the
    // stream. The client surfaces this as `closed: 'graceful'` (distinct from
    // `'remote'`, which is the transport-drop / no-result path).
    await handler.close();
    await expect(sub.closed).resolves.toBe('graceful');
    await client.close();
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

verifies('subscriptions:listen:honored-filter-narrows-to-advertised', async () => {
    // makeServer registers a tool but no prompts/resources: a listen requesting
    // toolsListChanged + promptsListChanged + resourcesListChanged must come
    // back honored as toolsListChanged only — the ack reflects only what the
    // server advertises.
    await using h = await hostListen();
    const sub = await h.client.listen({ toolsListChanged: true, promptsListChanged: true, resourcesListChanged: true });
    expect(sub.honoredFilter).toEqual({ toolsListChanged: true });
    // And nothing the server doesn't advertise reaches the stream: the entry
    // delivers via the same narrowed filter it acknowledged.
    const seen: string[] = [];
    h.client.setNotificationHandler('notifications/prompts/list_changed', () => void seen.push('prompts'));
    h.client.setNotificationHandler('notifications/tools/list_changed', () => void seen.push('tools'));
    h.handler.notify.promptsChanged();
    h.handler.notify.toolsChanged();
    await new Promise(r => setTimeout(r, 30));
    expect(seen).toEqual(['tools']);
    await sub.close();
});

// 2026-era siblings of the captured-instance list_changed publish rows: the
// publication path is handler.notify.* and delivery rides subscriptions/listen.

verifies('tools:listen:list-changed', async () => {
    await using h = await hostListenAllKinds();
    const seen: string[] = [];
    h.client.setNotificationHandler('notifications/tools/list_changed', () => void seen.push('tools'));
    const sub = await h.client.listen({ toolsListChanged: true });
    expect(sub.honoredFilter).toEqual({ toolsListChanged: true });
    h.handler.notify.toolsChanged();
    await new Promise(r => setTimeout(r, 30));
    expect(seen).toEqual(['tools']);
    await sub.close();
});

verifies('resources:listen:list-changed', async () => {
    await using h = await hostListenAllKinds();
    const seen: string[] = [];
    h.client.setNotificationHandler('notifications/resources/list_changed', () => void seen.push('resources'));
    const sub = await h.client.listen({ resourcesListChanged: true });
    expect(sub.honoredFilter).toEqual({ resourcesListChanged: true });
    h.handler.notify.resourcesChanged();
    await new Promise(r => setTimeout(r, 30));
    expect(seen).toEqual(['resources']);
    await sub.close();
});

verifies('prompts:listen:list-changed', async () => {
    await using h = await hostListenAllKinds();
    const seen: string[] = [];
    h.client.setNotificationHandler('notifications/prompts/list_changed', () => void seen.push('prompts'));
    const sub = await h.client.listen({ promptsListChanged: true });
    expect(sub.honoredFilter).toEqual({ promptsListChanged: true });
    h.handler.notify.promptsChanged();
    await new Promise(r => setTimeout(r, 30));
    expect(seen).toEqual(['prompts']);
    await sub.close();
});

verifies('client:listen:auto-refresh', async () => {
    const factory = () => {
        const server = new McpServer({ name: 'subs-e2e', version: '1' });
        server.registerTool('greet', { inputSchema: z.object({}) }, async () => ({ content: [] }));
        return server;
    };
    const handler = createMcpHandler(factory, { legacy: 'reject', keepAliveMs: 0 });
    const fetch = (u: URL | string, init?: RequestInit) => handler.fetch(new Request(u, init));
    let done!: () => void;
    const finished = new Promise<void>(r => {
        done = r;
    });
    const refreshed: unknown[] = [];
    const client = new Client(
        { name: 'subs-e2e-client', version: '1' },
        {
            versionNegotiation: { mode: 'auto' },
            listChanged: {
                tools: {
                    onChanged: (error, tools) => {
                        expect(error).toBeNull();
                        refreshed.push(tools);
                        done();
                    }
                }
            }
        }
    );
    await client.connect(new StreamableHTTPClientTransport(new URL('http://in-process/mcp'), { fetch }));
    expect(client.autoOpenedSubscription?.honoredFilter).toEqual({ toolsListChanged: true });
    handler.notify.toolsChanged();
    await finished;
    // The auto-refresh re-fetched tools/list and delivered the fresh result.
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0]).toEqual([expect.objectContaining({ name: 'greet' })]);
    await client.autoOpenedSubscription!.close();
    await client.close();
    await handler.close();
});

verifies('subscriptions:listen:capacity-guard', async () => {
    const handler = createMcpHandler(() => makeServer(), { legacy: 'reject', keepAliveMs: 0, maxSubscriptions: 1 });
    const post = (id: number) =>
        handler.fetch(
            new Request('http://in-process/mcp', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream',
                    'mcp-method': 'subscriptions/listen'
                },
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
