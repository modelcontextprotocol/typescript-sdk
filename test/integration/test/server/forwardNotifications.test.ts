import { createServer } from 'node:http';

import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { ServerEvent } from '@modelcontextprotocol/server';
import {
    classifyInboundRequest,
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    createMcpHandler,
    InMemoryServerEventBus,
    McpServer,
    PerRequestHTTPServerTransport,
    PROTOCOL_VERSION_META_KEY,
    Server,
    SUBSCRIPTION_ID_META_KEY
} from '@modelcontextprotocol/server';
import { listenOnRandomPort } from '@modelcontextprotocol/test-helpers';
import { describe, expect, it } from 'vitest';

const revision = '2026-07-28';
const envelope = {
    [PROTOCOL_VERSION_META_KEY]: revision,
    [CLIENT_INFO_META_KEY]: { name: 'forwarding-client', version: '1' },
    [CLIENT_CAPABILITIES_META_KEY]: {}
};

describe('public gateway serving APIs', () => {
    it.each([
        ['tools_list_changed', 'notifications/tools/list_changed'],
        ['prompts_list_changed', 'notifications/prompts/list_changed'],
        ['resources_list_changed', 'notifications/resources/list_changed'],
        ['resource_updated', 'notifications/resources/updated']
    ] as const)('preserves forwarded %s params on the subscription stream', async (kind, method) => {
        const bus = new InMemoryServerEventBus();
        const handler = createMcpHandler(
            () =>
                new Server(
                    { name: 'gateway', version: '1' },
                    {
                        capabilities: {
                            tools: { listChanged: true },
                            prompts: { listChanged: true },
                            resources: { listChanged: true, subscribe: true }
                        }
                    }
                ),
            { bus, keepAliveMs: 0 }
        );
        const http = createServer(toNodeHandler(handler));
        const url = await listenOnRandomPort(http);
        const abort = new AbortController();
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream',
                    'MCP-Protocol-Version': revision,
                    'Mcp-Method': 'subscriptions/listen'
                },
                signal: abort.signal,
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 'downstream',
                    method: 'subscriptions/listen',
                    params: {
                        _meta: envelope,
                        notifications: {
                            toolsListChanged: true,
                            promptsListChanged: true,
                            resourcesListChanged: true,
                            resourceSubscriptions: ['file:///config']
                        }
                    }
                })
            });
            expect(response.status).toBe(200);
            const reader = response.body!.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            const next = async () => {
                while (!buffer.includes('\n\n')) {
                    const chunk = await reader.read();
                    if (chunk.done) throw new Error('Subscription ended before notification');
                    buffer += decoder.decode(chunk.value, { stream: true });
                }
                const end = buffer.indexOf('\n\n');
                const frame = buffer.slice(0, end);
                buffer = buffer.slice(end + 2);
                return JSON.parse(
                    frame
                        .split('\n')
                        .find(line => line.startsWith('data: '))!
                        .slice(6)
                );
            };
            const acknowledgement = await next();
            expect(acknowledgement.method).toBe('notifications/subscriptions/acknowledged');
            const params = {
                _meta: { fixture: 'kept', nested: { value: 7 }, [SUBSCRIPTION_ID_META_KEY]: 'upstream' },
                extension: { changed: ['one', 'two'] },
                ...(kind === 'resource_updated' ? { uri: 'file:///upstream' } : {})
            };
            const event: ServerEvent = kind === 'resource_updated' ? { kind, uri: 'file:///config', params } : { kind, params };
            bus.publish(event);
            expect(await next()).toEqual({
                jsonrpc: '2.0',
                method,
                params: {
                    ...params,
                    ...(kind === 'resource_updated' ? { uri: 'file:///config' } : {}),
                    _meta: { ...params._meta, [SUBSCRIPTION_ID_META_KEY]: 'downstream' }
                }
            });
            expect(params._meta[SUBSCRIPTION_ID_META_KEY]).toBe('upstream');
            await reader.cancel();
        } finally {
            abort.abort();
            await handler.close();
            await new Promise<void>((resolve, reject) => http.close(error => (error ? reject(error) : resolve())));
        }
    });

    it.each(['Server', 'McpServer'] as const)('admits a classified modern request on a manually connected %s', async kind => {
        const message = { jsonrpc: '2.0' as const, id: 1, method: 'tools/list', params: { _meta: envelope } };
        const route = classifyInboundRequest({
            httpMethod: 'POST',
            protocolVersionHeader: revision,
            mcpMethodHeader: message.method,
            body: message
        });
        if (route.kind !== 'modern') throw new Error('Expected modern request');
        const server =
            kind === 'Server'
                ? new Server(
                      { name: 'gateway', version: '1' },
                      {
                          supportedProtocolVersions: [revision],
                          capabilities: { tools: {} }
                      }
                  )
                : new McpServer(
                      { name: 'gateway', version: '1' },
                      {
                          supportedProtocolVersions: [revision],
                          capabilities: { tools: {} }
                      }
                  );
        let called = false;
        const protocol = server instanceof McpServer ? server.server : server;
        protocol.setRequestHandler('tools/list', () => {
            called = true;
            return { tools: [] };
        });
        const transport = new PerRequestHTTPServerTransport({ classification: route.classification });
        try {
            await server.connect(transport);
            const response = await transport.handleMessage(route.message);
            expect(response.status).toBe(200);
            expect(called).toBe(true);
            expect(await response.json()).toMatchObject({ id: 1, result: { tools: [] } });
        } finally {
            await server.close();
        }
    });

    it.each([
        ['2030-01-01', ['2025-11-25']],
        [revision, ['2025-11-25']],
        ['2030-01-01', [revision, '2030-01-01']]
    ])('answers a %s classification with -32022 when the server lists %j', async (classified, supportedProtocolVersions) => {
        const server = new Server({ name: 'gateway', version: '1' }, { supportedProtocolVersions, capabilities: { tools: {} } });
        server.setRequestHandler('tools/list', () => ({ tools: [] }));
        server.onerror = () => {};
        const transport = new PerRequestHTTPServerTransport({ classification: { era: 'modern', revision: classified } });
        try {
            await server.connect(transport);
            expect(server.getNegotiatedProtocolVersion()).toBeUndefined();
            const response = await transport.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: envelope } });
            expect(response.status).toBe(400);
            expect(await response.json()).toMatchObject({ id: 1, error: { code: -32_022, data: { requested: classified } } });
        } finally {
            await server.close();
        }
    });

    it('allows a legacy connection after closing a transport-bound modern connection', async () => {
        const server = new Server(
            { name: 'gateway', version: '1' },
            {
                supportedProtocolVersions: [revision, '2025-11-25']
            }
        );
        const modern = new PerRequestHTTPServerTransport({ classification: { era: 'modern', revision } });
        let versionInOnclose: string | undefined;
        server.onclose = () => {
            versionInOnclose = server.getNegotiatedProtocolVersion();
        };
        await server.connect(modern);
        expect(server.getNegotiatedProtocolVersion()).toBe(revision);
        await server.close();
        expect(versionInOnclose).toBe(revision);
        server.onclose = undefined;
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: 'legacy-client', version: '1' });
        try {
            await server.connect(serverTransport);
            await client.connect(clientTransport);
            expect(server.getNegotiatedProtocolVersion()).toBe('2025-11-25');
        } finally {
            await client.close();
            await server.close();
        }
    });

    it('allows a legacy connection made from onclose of a transport-bound modern connection', async () => {
        const server = new Server({ name: 'gateway', version: '1' }, { supportedProtocolVersions: [revision, '2025-11-25'] });
        await server.connect(new PerRequestHTTPServerTransport({ classification: { era: 'modern', revision } }));
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        let reconnected: Promise<void> | undefined;
        server.onclose = () => {
            server.onclose = undefined;
            reconnected = server.connect(serverTransport);
        };
        await server.close();
        await reconnected;
        const client = new Client({ name: 'legacy-client', version: '1' });
        try {
            await client.connect(clientTransport);
            expect(server.getNegotiatedProtocolVersion()).toBe('2025-11-25');
        } finally {
            await client.close();
            await server.close();
        }
    });
});
