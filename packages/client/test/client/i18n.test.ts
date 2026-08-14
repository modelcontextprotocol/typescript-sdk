import type { JSONRPCMessage, JSONRPCRequest } from '@modelcontextprotocol/core-internal';
import {
    ACCEPT_LANGUAGE_META,
    CONTENT_LANGUAGE_META,
    getAcceptLanguage,
    InMemoryTransport,
    SdkErrorCode
} from '@modelcontextprotocol/core-internal';
import { describe, expect, it, vi } from 'vitest';

import { Client } from '../../src/client/client';
import { StreamableHTTPClientTransport } from '../../src/client/streamableHttp';
import { buildProbeRequest } from '../../src/client/versionNegotiation';

function request(id: number, acceptLanguage?: string): JSONRPCRequest {
    return {
        jsonrpc: '2.0',
        id,
        method: 'tools/list',
        params: acceptLanguage === undefined ? {} : { _meta: { [ACCEPT_LANGUAGE_META]: acceptLanguage } }
    };
}

describe('StreamableHTTPClientTransport language mirroring', () => {
    it('mirrors each request independently and does not retain an omitted preference', async () => {
        const seen: Array<{ header: string | null; metadata: string | undefined }> = [];
        const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
            const message = JSON.parse(String(init?.body)) as JSONRPCRequest;
            const headers = new Headers(init?.headers);
            seen.push({ header: headers.get('accept-language'), metadata: getAcceptLanguage(message.params) });
            return Response.json({ jsonrpc: '2.0', id: message.id, result: {} }, { headers: { 'Content-Type': 'application/json' } });
        });

        const transport = new StreamableHTTPClientTransport(new URL('http://example.test/mcp'), {
            fetch: fetch as typeof globalThis.fetch
        });
        await transport.start();

        await transport.send(request(1, 'en'));
        await transport.send(request(2, 'fr-CA, fr;q=0.9'));
        await transport.send(request(3));

        expect(seen).toEqual([
            { header: 'en', metadata: 'en' },
            { header: 'fr-CA, fr;q=0.9', metadata: 'fr-CA, fr;q=0.9' },
            { header: null, metadata: undefined }
        ]);
        await transport.close();
    });

    it('emits one authoritative field value even when requestInit supplied an earlier value', async () => {
        let observed: string | null = null;
        const initialHeaders = new Headers();
        initialHeaders.append('Accept-Language', 'de');
        initialHeaders.append('Accept-Language', 'en');
        const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
            const message = JSON.parse(String(init?.body)) as JSONRPCRequest;
            observed = new Headers(init?.headers).get('accept-language');
            return Response.json({ jsonrpc: '2.0', id: message.id, result: {} }, { headers: { 'Content-Type': 'application/json' } });
        });
        const transport = new StreamableHTTPClientTransport(new URL('http://example.test/mcp'), {
            fetch: fetch as typeof globalThis.fetch,
            requestInit: { headers: initialHeaders }
        });
        await transport.start();
        await transport.send(request(1, 'fr-CA, fr;q=0.9'));
        expect(observed).toBe('fr-CA, fr;q=0.9');
        await transport.close();
    });

    it('accepts a matching or stripped Content-Language mirror', async () => {
        let call = 0;
        const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
            const message = JSON.parse(String(init?.body)) as JSONRPCRequest;
            call++;
            return Response.json(
                {
                    jsonrpc: '2.0',
                    id: message.id,
                    result: { _meta: { [CONTENT_LANGUAGE_META]: 'fr' } }
                },
                {
                    headers: {
                        'Content-Type': 'application/json',
                        ...(call === 1 && { 'Content-Language': 'fr' })
                    }
                }
            );
        });
        const transport = new StreamableHTTPClientTransport(new URL('http://example.test/mcp'), {
            fetch: fetch as typeof globalThis.fetch
        });
        await transport.start();
        await expect(transport.send(request(1, 'fr'))).resolves.toBeUndefined();
        await expect(transport.send(request(2, 'fr'))).resolves.toBeUndefined();
        await transport.close();
    });

    it.each([
        ['en-US', 'en-us'],
        ['en-US,fr;q=0.9', 'en-US, fr;q=0.9'],
        ['en;q=0.9', 'en;q=0.900']
    ])('rejects malformed conflicting JSON response mirrors (%s vs %s)', async (header, metadata) => {
        const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
            const message = JSON.parse(String(init?.body)) as JSONRPCRequest;
            return Response.json(
                {
                    jsonrpc: '2.0',
                    id: message.id,
                    result: { _meta: { [CONTENT_LANGUAGE_META]: metadata } }
                },
                { headers: { 'Content-Type': 'application/json', 'Content-Language': header } }
            );
        });
        const transport = new StreamableHTTPClientTransport(new URL('http://example.test/mcp'), {
            fetch: fetch as typeof globalThis.fetch
        });
        await transport.start();
        await expect(transport.send(request(1, 'fr'))).rejects.toMatchObject({ code: SdkErrorCode.ClientHttpUnexpectedContent });
        await transport.close();
    });

    it('rejects a conflicting Content-Language mirror on JSON-RPC error.data._meta', async () => {
        const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
            const message = JSON.parse(String(init?.body)) as JSONRPCRequest;
            return Response.json(
                {
                    jsonrpc: '2.0',
                    id: message.id,
                    error: {
                        code: -32_602,
                        message: 'Erreur',
                        data: { _meta: { [CONTENT_LANGUAGE_META]: 'fr' } }
                    }
                },
                { headers: { 'Content-Type': 'application/json', 'Content-Language': 'de' } }
            );
        });
        const transport = new StreamableHTTPClientTransport(new URL('http://example.test/mcp'), {
            fetch: fetch as typeof globalThis.fetch
        });
        await transport.start();
        await expect(transport.send(request(1, 'fr'))).rejects.toMatchObject({ code: SdkErrorCode.ClientHttpUnexpectedContent });
        await transport.close();
    });

    it('treats combined conflicting Content-Language field values as malformed', async () => {
        const headers = new Headers({ 'Content-Type': 'application/json' });
        headers.append('Content-Language', 'fr');
        headers.append('Content-Language', 'de');
        const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
            const message = JSON.parse(String(init?.body)) as JSONRPCRequest;
            return new Response(
                JSON.stringify({
                    jsonrpc: '2.0',
                    id: message.id,
                    result: { _meta: { [CONTENT_LANGUAGE_META]: 'fr' } }
                }),
                { headers }
            );
        });
        const transport = new StreamableHTTPClientTransport(new URL('http://example.test/mcp'), {
            fetch: fetch as typeof globalThis.fetch
        });
        await transport.start();
        await expect(transport.send(request(1, 'fr'))).rejects.toMatchObject({ code: SdkErrorCode.ClientHttpUnexpectedContent });
        await transport.close();
    });

    it('accepts repeated Content-Language lines when their combined value agrees exactly', async () => {
        const headers = new Headers({ 'Content-Type': 'application/json' });
        headers.append('Content-Language', 'fr');
        headers.append('Content-Language', 'de');
        const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
            const message = JSON.parse(String(init?.body)) as JSONRPCRequest;
            return new Response(
                JSON.stringify({
                    jsonrpc: '2.0',
                    id: message.id,
                    result: { _meta: { [CONTENT_LANGUAGE_META]: 'fr, de' } }
                }),
                { headers }
            );
        });
        const transport = new StreamableHTTPClientTransport(new URL('http://example.test/mcp'), {
            fetch: fetch as typeof globalThis.fetch
        });
        await transport.start();
        await expect(transport.send(request(1, 'fr'))).resolves.toBeUndefined();
        await transport.close();
    });

    it('validates a stream-wide SSE header against each message while retaining per-message metadata', async () => {
        const error = new Promise<Error>(resolve => {
            const message: JSONRPCMessage = {
                jsonrpc: '2.0',
                id: 1,
                result: { _meta: { [CONTENT_LANGUAGE_META]: 'fr' } }
            };
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`));
                    controller.close();
                }
            });
            const transport = new StreamableHTTPClientTransport(new URL('http://example.test/mcp'), {
                fetch: (async () =>
                    new Response(stream, {
                        headers: { 'Content-Type': 'text/event-stream', 'Content-Language': 'de' }
                    })) as typeof globalThis.fetch
            });
            transport.onerror = resolve;
            void transport.start().then(() => transport.send(request(1, 'fr')));
        });
        await expect(error).resolves.toMatchObject({ code: SdkErrorCode.ClientHttpUnexpectedContent });
    });
});

describe('request-scoped API on transport-neutral connections', () => {
    it('carries a connect-time preference on the server/discover probe', () => {
        const probe = buildProbeRequest('probe-1', '2026-07-28', { name: 'i18n-client', version: '1.0.0' }, {}, 'fr-CA, fr;q=0.9');
        expect(getAcceptLanguage(probe.params)).toBe('fr-CA, fr;q=0.9');
    });

    it('supports changing and omitting acceptLanguage on consecutive Client requests', async () => {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const seen: Array<string | undefined> = [];
        serverTransport.onmessage = message => {
            if (!('method' in message) || !('id' in message)) return;
            if (message.method === 'initialize') {
                void serverTransport.send({
                    jsonrpc: '2.0',
                    id: message.id,
                    result: {
                        protocolVersion: '2025-11-25',
                        capabilities: { tools: {} },
                        serverInfo: { name: 'fake-server', version: '1.0.0' }
                    }
                });
                return;
            }
            if (message.method === 'tools/list') {
                seen.push(getAcceptLanguage(message.params));
                void serverTransport.send({
                    jsonrpc: '2.0',
                    id: message.id,
                    result: { tools: [] }
                });
                return;
            }
            if (message.method === 'ping') {
                seen.push(getAcceptLanguage(message.params));
                void serverTransport.send({ jsonrpc: '2.0', id: message.id, result: {} });
            }
        };
        await serverTransport.start();

        const client = new Client({ name: 'i18n-client', version: '1.0.0' });
        await client.connect(clientTransport);
        await client.ping({ acceptLanguage: 'de' });
        await client.listTools(undefined, { acceptLanguage: 'en', cacheMode: 'bypass' });
        await client.listTools(undefined, { acceptLanguage: 'fr', cacheMode: 'bypass' });
        await client.listTools(undefined, { cacheMode: 'bypass' });
        await expect(client.ping({ acceptLanguage: ' en' })).rejects.toBeInstanceOf(TypeError);

        expect(seen).toEqual(['de', 'en', 'fr', undefined]);
        await client.close();
    });
});
