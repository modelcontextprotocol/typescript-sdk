import type { IncomingMessage, Server } from 'node:http';
import { createServer } from 'node:http';

import type { JSONRPCMessage } from '@modelcontextprotocol/core-internal';
import { SdkErrorCode, SdkHttpError } from '@modelcontextprotocol/core-internal';
import { listenOnRandomPort } from '@modelcontextprotocol/test-helpers';
import type { Mock } from 'vitest';

import { SSEClientTransport } from '../../src/client/sse';
import { StreamableHTTPClientTransport } from '../../src/client/streamableHttp';

/**
 * Pins the transports' explicit redirect handling: MCP requests go out with
 * `redirect: 'manual'`; GET redirects are followed (same-origin with headers
 * intact, cross-origin with only the request-describing set), bounded at
 * 3 hops; POST/DELETE redirects are never re-sent and surface as
 * `SdkHttpError` (`ClientHttpRedirectNotFollowed`); a runtime-filtered
 * redirect (Fetch `opaqueredirect`) surfaces as the same code with the
 * remedies named; `redirectPolicy: 'follow'` restores delegation to the fetch
 * implementation.
 */

const ENDPOINT_URL = 'http://localhost:1234/mcp';

const testMessage: JSONRPCMessage = {
    jsonrpc: '2.0',
    method: 'test',
    params: {},
    id: 'test-id'
};

function redirectResponse(location: string | null, status = 307): Response {
    const headers = new Headers();
    if (location !== null) {
        headers.set('location', location);
    }
    return new Response(null, { status, headers });
}

/**
 * The shape browser runtimes resolve a `redirect: 'manual'` fetch with when the
 * response status is a redirect: an opaque redirect — status 0, no readable
 * headers (Fetch "opaqueredirect" filtered response).
 */
function opaqueRedirectResponse(): Response {
    return {
        ok: false,
        status: 0,
        statusText: '',
        type: 'opaqueredirect',
        headers: new Headers(),
        text: async () => ''
    } as unknown as Response;
}

function sseResponse(): Response {
    return new Response(
        new ReadableStream<Uint8Array>({
            start(controller) {
                controller.close();
            }
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
    );
}

describe('StreamableHTTPClientTransport redirect handling', () => {
    let fetchMock: Mock;
    let transport: StreamableHTTPClientTransport;

    const makeTransport = (opts?: { redirectPolicy?: 'manual' | 'follow'; requestInit?: RequestInit }): StreamableHTTPClientTransport =>
        new StreamableHTTPClientTransport(new URL(ENDPOINT_URL), {
            fetch: fetchMock as unknown as typeof fetch,
            authProvider: { token: async () => 'test-token' },
            sessionId: 'session-1',
            protocolVersion: '2025-06-18',
            requestInit: opts?.requestInit ?? { headers: { 'x-custom-header': 'custom-value' }, cache: 'no-store' },
            redirectPolicy: opts?.redirectPolicy
        });

    beforeEach(() => {
        fetchMock = vi.fn();
        transport = makeTransport();
        transport.onerror = vi.fn();
    });

    afterEach(async () => {
        await transport.close().catch(() => {});
    });

    it('issues POST, GET and DELETE requests with redirect: manual by default', async () => {
        fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
        await transport.start();
        await transport.send(testMessage);
        expect(fetchMock.mock.calls[0]![1].redirect).toBe('manual');

        fetchMock.mockResolvedValue(sseResponse());
        await transport.resumeStream('token-1');
        expect(fetchMock.mock.calls[1]![1].redirect).toBe('manual');

        fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
        await transport.terminateSession();
        expect(fetchMock.mock.calls[2]![1].redirect).toBe('manual');
    });

    it('follows a same-origin GET redirect with the original headers intact', async () => {
        fetchMock.mockResolvedValueOnce(redirectResponse('http://localhost:1234/mcp-moved')).mockResolvedValueOnce(sseResponse());
        await transport.start();
        await transport.resumeStream('token-123');

        expect(fetchMock).toHaveBeenCalledTimes(2);
        const [url, init] = fetchMock.mock.calls[1]!;
        expect(url.toString()).toBe('http://localhost:1234/mcp-moved');
        const headers = init.headers as Headers;
        expect(headers.get('authorization')).toBe('Bearer test-token');
        expect(headers.get('x-custom-header')).toBe('custom-value');
        expect(headers.get('mcp-session-id')).toBe('session-1');
        expect(headers.get('mcp-protocol-version')).toBe('2025-06-18');
        expect(headers.get('last-event-id')).toBe('token-123');
        // The connection-level requestInit still applies on the same origin.
        expect(init.cache).toBe('no-store');
        expect(init.redirect).toBe('manual');
    });

    it('follows a cross-origin GET redirect without the connection-configured headers', async () => {
        fetchMock.mockResolvedValueOnce(redirectResponse('http://elsewhere.example:9999/mcp')).mockResolvedValueOnce(sseResponse());
        await transport.start();
        await transport.resumeStream('token-123');

        expect(fetchMock).toHaveBeenCalledTimes(2);
        const [url, init] = fetchMock.mock.calls[1]!;
        expect(url.toString()).toBe('http://elsewhere.example:9999/mcp');
        const headers = init.headers as Headers;
        // Connection-scoped values stay on the configured origin.
        expect(headers.get('authorization')).toBeNull();
        expect(headers.get('x-custom-header')).toBeNull();
        expect(headers.get('mcp-session-id')).toBeNull();
        // The request-describing set the target needs is carried.
        expect(headers.get('accept')).toBe('text/event-stream');
        expect(headers.get('mcp-protocol-version')).toBe('2025-06-18');
        expect(headers.get('last-event-id')).toBe('token-123');
        // The connection-level requestInit does not apply either.
        expect('cache' in init).toBe(false);
        expect(init.redirect).toBe('manual');
    });

    it('keeps the minimal header set for the rest of the chain once a hop leaves the origin', async () => {
        fetchMock
            .mockResolvedValueOnce(redirectResponse('http://elsewhere.example:9999/mcp'))
            .mockResolvedValueOnce(redirectResponse('http://localhost:1234/mcp-return'))
            .mockResolvedValueOnce(sseResponse());
        await transport.start();
        await transport.resumeStream('token-123');

        expect(fetchMock).toHaveBeenCalledTimes(3);
        const [url, init] = fetchMock.mock.calls[2]!;
        // The chain pointed back to the configured origin, but header dropping
        // is never undone within a chain.
        expect(url.toString()).toBe('http://localhost:1234/mcp-return');
        const headers = init.headers as Headers;
        expect(headers.get('authorization')).toBeNull();
        expect(headers.get('x-custom-header')).toBeNull();
        expect(headers.get('accept')).toBe('text/event-stream');
    });

    it.each([
        ['same-origin', 'http://localhost:1234/mcp-moved'],
        ['cross-origin', 'http://elsewhere.example:9999/mcp']
    ])('does not re-send a POST answered with a %s redirect', async (_kind, location) => {
        fetchMock.mockResolvedValue(redirectResponse(location));
        await transport.start();

        const error = await transport.send(testMessage).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SdkHttpError);
        expect((error as SdkHttpError).code).toBe(SdkErrorCode.ClientHttpRedirectNotFollowed);
        expect((error as SdkHttpError).status).toBe(307);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does not adopt a session id from a redirect response', async () => {
        const headers = new Headers({ location: 'http://localhost:1234/mcp-moved', 'mcp-session-id': 'minted-elsewhere' });
        fetchMock.mockResolvedValue(new Response(null, { status: 307, headers }));
        const freshTransport = new StreamableHTTPClientTransport(new URL(ENDPOINT_URL), {
            fetch: fetchMock as unknown as typeof fetch
        });
        freshTransport.onerror = vi.fn();
        await freshTransport.start();

        await expect(freshTransport.send(testMessage)).rejects.toThrow(SdkHttpError);
        expect(freshTransport.sessionId).toBeUndefined();
        await freshTransport.close();
    });

    it('does not re-send a DELETE answered with a redirect', async () => {
        fetchMock.mockResolvedValue(redirectResponse('http://localhost:1234/mcp-moved', 308));
        await transport.start();

        const error = await transport.terminateSession().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SdkHttpError);
        expect((error as SdkHttpError).code).toBe(SdkErrorCode.ClientHttpRedirectNotFollowed);
        expect((error as SdkHttpError).status).toBe(308);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('stops following GET redirects after 3 hops', async () => {
        fetchMock.mockResolvedValue(redirectResponse('http://localhost:1234/again'));
        await transport.start();

        const error = await transport.resumeStream('token-123').catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SdkHttpError);
        expect((error as SdkHttpError).code).toBe(SdkErrorCode.ClientHttpRedirectNotFollowed);
        expect((error as SdkHttpError).message).toMatch(/Redirect limit of 3 hops exceeded/);
        // Initial request plus the 3 followed hops.
        expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('surfaces a GET redirect without a Location header as an error', async () => {
        fetchMock.mockResolvedValue(redirectResponse(null, 302));
        await transport.start();

        const error = await transport.resumeStream('token-123').catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SdkHttpError);
        expect((error as SdkHttpError).code).toBe(SdkErrorCode.ClientHttpRedirectNotFollowed);
        expect((error as SdkHttpError).message).toMatch(/without a Location header/);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['GET', (): Promise<unknown> => transport.resumeStream('token-123')],
        ['POST', (): Promise<unknown> => transport.send(testMessage)]
    ] as const)(
        'surfaces a runtime-filtered redirect (opaqueredirect) of a %s as a clear error naming redirectPolicy',
        async (_method, request) => {
            fetchMock.mockResolvedValue(opaqueRedirectResponse());
            await transport.start();

            const error = await request().catch((e: unknown) => e);
            expect(error).toBeInstanceOf(SdkHttpError);
            expect((error as SdkHttpError).code).toBe(SdkErrorCode.ClientHttpRedirectNotFollowed);
            expect((error as SdkHttpError).status).toBe(0);
            expect((error as SdkHttpError).message).toMatch(/redirect this runtime filters/);
            expect((error as SdkHttpError).message).toMatch(/redirectPolicy: 'follow'/);
            expect((error as SdkHttpError).message).toMatch(/without redirects/);
            expect(fetchMock).toHaveBeenCalledTimes(1);
        }
    );

    it('surfaces a runtime-filtered redirect on a followed GET hop the same way', async () => {
        fetchMock
            .mockResolvedValueOnce(redirectResponse('http://localhost:1234/mcp-moved'))
            .mockResolvedValueOnce(opaqueRedirectResponse());
        await transport.start();

        const error = await transport.resumeStream('token-123').catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SdkHttpError);
        expect((error as SdkHttpError).code).toBe(SdkErrorCode.ClientHttpRedirectNotFollowed);
        expect((error as SdkHttpError).status).toBe(0);
        expect((error as SdkHttpError).message).toMatch(/redirectPolicy: 'follow'/);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("redirectPolicy: 'follow' is unaffected in runtimes that filter manual-redirect responses", async () => {
        await transport.close();
        transport = makeTransport({ redirectPolicy: 'follow' });
        transport.onerror = vi.fn();
        await transport.start();

        // A runtime that filters redirect responses does so only for
        // redirect: 'manual' requests; the 'follow' policy never sets the
        // field, so the platform follows the chain and the transport sees the
        // chain-end response.
        fetchMock.mockImplementation(async (_url: URL, init: RequestInit) =>
            init.redirect === 'manual' ? opaqueRedirectResponse() : new Response(null, { status: 202 })
        );
        await expect(transport.send(testMessage)).resolves.toBeUndefined();

        fetchMock.mockImplementation(async (_url: URL, init: RequestInit) =>
            init.redirect === 'manual' ? opaqueRedirectResponse() : sseResponse()
        );
        await expect(transport.resumeStream('token-123')).resolves.toBeUndefined();
    });

    it("redirectPolicy: 'follow' delegates redirect handling to the fetch implementation", async () => {
        await transport.close();
        transport = makeTransport({ redirectPolicy: 'follow', requestInit: { redirect: 'error' } });
        transport.onerror = vi.fn();
        await transport.start();

        fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
        await transport.send(testMessage);
        // No manual override: the requestInit's own redirect mode flows through.
        expect(fetchMock.mock.calls[0]![1].redirect).toBe('error');

        // A 3xx that still reaches the transport is not intercepted or
        // followed by the transport; it fails the ordinary status handling.
        fetchMock.mockResolvedValue(redirectResponse('http://localhost:1234/mcp-moved'));
        const error = await transport.resumeStream('token-123').catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SdkHttpError);
        expect((error as SdkHttpError).code).toBe(SdkErrorCode.ClientHttpFailedToOpenStream);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});

describe('SSEClientTransport redirect handling', () => {
    let serverA: Server;
    let serverB: Server;
    let baseA: URL;
    let baseB: URL;
    let requestsA: { method: string; url: string; headers: IncomingMessage['headers'] }[];
    let requestsB: { method: string; url: string; headers: IncomingMessage['headers'] }[];
    let handleA: (req: IncomingMessage, res: import('node:http').ServerResponse) => void;
    let handleB: (req: IncomingMessage, res: import('node:http').ServerResponse) => void;
    let transport: SSEClientTransport;

    const serveSseStream = (res: import('node:http').ServerResponse): void => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write('event: endpoint\n');
        res.write('data: /messages\n\n');
    };

    beforeEach(async () => {
        requestsA = [];
        requestsB = [];
        handleA = (_req, res) => res.writeHead(404).end();
        handleB = (_req, res) => res.writeHead(404).end();

        serverA = createServer((req, res) => {
            requestsA.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
            handleA(req, res);
        });
        serverB = createServer((req, res) => {
            requestsB.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
            handleB(req, res);
        });
        baseA = await listenOnRandomPort(serverA);
        baseB = await listenOnRandomPort(serverB);
    });

    afterEach(async () => {
        await transport?.close().catch(() => {});
        serverA.closeAllConnections?.();
        serverB.closeAllConnections?.();
        await new Promise(resolve => serverA.close(resolve));
        await new Promise(resolve => serverB.close(resolve));
    });

    const makeTransport = (): SSEClientTransport =>
        new SSEClientTransport(new URL('/sse', baseA), {
            authProvider: { token: async () => 'test-token' },
            requestInit: { headers: { 'x-custom-header': 'custom-value' } }
        });

    it('follows a same-origin redirect of the stream GET with headers intact', async () => {
        handleA = (req, res) => {
            if (req.url === '/sse') {
                res.writeHead(307, { Location: '/sse-moved' }).end();
                return;
            }
            if (req.url === '/sse-moved') {
                serveSseStream(res);
                return;
            }
            res.writeHead(404).end();
        };

        transport = makeTransport();
        await transport.start();

        expect(requestsA.map(r => r.url)).toEqual(['/sse', '/sse-moved']);
        const followed = requestsA[1]!;
        expect(followed.headers['authorization']).toBe('Bearer test-token');
        expect(followed.headers['x-custom-header']).toBe('custom-value');
        expect(followed.headers['accept']).toBe('text/event-stream');
    });

    it('follows a cross-origin redirect of the stream GET without the connection-configured headers', async () => {
        handleA = (req, res) => {
            if (req.url === '/sse') {
                res.writeHead(307, { Location: new URL('/sse', baseB).href }).end();
                return;
            }
            res.writeHead(404).end();
        };
        handleB = (req, res) => {
            if (req.url === '/sse') {
                serveSseStream(res);
                return;
            }
            res.writeHead(404).end();
        };

        transport = makeTransport();
        await transport.start();

        expect(requestsB.map(r => r.url)).toEqual(['/sse']);
        const followed = requestsB[0]!;
        expect(followed.headers['authorization']).toBeUndefined();
        expect(followed.headers['x-custom-header']).toBeUndefined();
        expect(followed.headers['accept']).toBe('text/event-stream');
    });

    it('does not re-send a message POST answered with a redirect', async () => {
        handleA = (req, res) => {
            if (req.url === '/sse') {
                serveSseStream(res);
                return;
            }
            if (req.url === '/messages' && req.method === 'POST') {
                res.writeHead(307, { Location: '/messages-moved' }).end();
                return;
            }
            res.writeHead(404).end();
        };

        transport = makeTransport();
        transport.onerror = vi.fn();
        await transport.start();

        const error = await transport.send(testMessage).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SdkHttpError);
        expect((error as SdkHttpError).code).toBe(SdkErrorCode.ClientHttpRedirectNotFollowed);
        expect((error as SdkHttpError).status).toBe(307);
        expect(requestsA.filter(r => r.url === '/messages-moved')).toHaveLength(0);
    });

    it('fails start() with the typed error (no reconnect) when the stream GET redirect cannot be followed', async () => {
        // A redirect without a Location can never be followed; the EventSource
        // must not schedule reconnects against it, and the typed error (not a
        // flattened SseError) must reach the caller.
        handleA = (req, res) => {
            if (req.url === '/sse') {
                res.writeHead(307).end();
                return;
            }
            res.writeHead(404).end();
        };

        transport = makeTransport();
        transport.onerror = vi.fn();

        const error = await transport.start().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SdkHttpError);
        expect((error as SdkHttpError).code).toBe(SdkErrorCode.ClientHttpRedirectNotFollowed);
        expect((error as SdkHttpError).status).toBe(307);
        expect(requestsA).toHaveLength(1);
    });

    it('fails start() with the clear error naming redirectPolicy on a runtime-filtered redirect of the stream GET', async () => {
        const fetchMock = vi.fn(async () => opaqueRedirectResponse());
        transport = new SSEClientTransport(new URL('/sse', baseA), {
            fetch: fetchMock as unknown as typeof fetch
        });
        transport.onerror = vi.fn();
        transport.onclose = vi.fn();

        const error = await transport.start().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SdkHttpError);
        expect((error as SdkHttpError).code).toBe(SdkErrorCode.ClientHttpRedirectNotFollowed);
        expect((error as SdkHttpError).status).toBe(0);
        expect((error as SdkHttpError).message).toMatch(/redirectPolicy: 'follow'/);
        // Terminal, not retried: the transport closed before the error propagated.
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(transport.onclose).toHaveBeenCalled();
    });
});
