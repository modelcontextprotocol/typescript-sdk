import type { JSONRPCMessage } from '@modelcontextprotocol/core';
import type { Mock } from 'vitest';

import type { TokenProvider } from '../../src/client/tokenProvider.js';
import { withBearerAuth } from '../../src/client/tokenProvider.js';
import { StreamableHTTPClientTransport } from '../../src/client/streamableHttp.js';
import { UnauthorizedError } from '../../src/client/auth.js';

describe('withBearerAuth', () => {
    it('should inject Authorization header when token is available', async () => {
        const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));
        const getToken: TokenProvider = async () => 'test-token-123';

        const authedFetch = withBearerAuth(getToken, mockFetch);
        await authedFetch('https://example.com/api', { method: 'POST' });

        expect(mockFetch).toHaveBeenCalledOnce();
        const [url, init] = mockFetch.mock.calls[0]!;
        expect(url).toBe('https://example.com/api');
        expect(new Headers(init.headers).get('Authorization')).toBe('Bearer test-token-123');
    });

    it('should not inject Authorization header when token is undefined', async () => {
        const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));
        const getToken: TokenProvider = async () => undefined;

        const authedFetch = withBearerAuth(getToken, mockFetch);
        await authedFetch('https://example.com/api', { method: 'POST' });

        expect(mockFetch).toHaveBeenCalledOnce();
        const [, init] = mockFetch.mock.calls[0]!;
        expect(new Headers(init?.headers).has('Authorization')).toBe(false);
    });

    it('should preserve existing headers', async () => {
        const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));
        const getToken: TokenProvider = async () => 'my-token';

        const authedFetch = withBearerAuth(getToken, mockFetch);
        await authedFetch('https://example.com/api', {
            headers: { 'Content-Type': 'application/json', 'X-Custom': 'value' }
        });

        const [, init] = mockFetch.mock.calls[0]!;
        const headers = new Headers(init.headers);
        expect(headers.get('Authorization')).toBe('Bearer my-token');
        expect(headers.get('Content-Type')).toBe('application/json');
        expect(headers.get('X-Custom')).toBe('value');
    });

    it('should call getToken on every request', async () => {
        const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));
        let callCount = 0;
        const getToken: TokenProvider = async () => `token-${++callCount}`;

        const authedFetch = withBearerAuth(getToken, mockFetch);
        await authedFetch('https://example.com/1');
        await authedFetch('https://example.com/2');

        expect(new Headers(mockFetch.mock.calls[0]![1]!.headers).get('Authorization')).toBe('Bearer token-1');
        expect(new Headers(mockFetch.mock.calls[1]![1]!.headers).get('Authorization')).toBe('Bearer token-2');
    });
});

describe('StreamableHTTPClientTransport with tokenProvider', () => {
    let transport: StreamableHTTPClientTransport;

    afterEach(async () => {
        await transport?.close().catch(() => {});
        vi.clearAllMocks();
    });

    it('should set Authorization header from tokenProvider', async () => {
        const tokenProvider: TokenProvider = vi.fn(async () => 'my-bearer-token');
        transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), { tokenProvider });
        vi.spyOn(globalThis, 'fetch');

        const message: JSONRPCMessage = {
            jsonrpc: '2.0',
            method: 'test',
            params: {},
            id: 'test-id'
        };

        (globalThis.fetch as Mock).mockResolvedValueOnce({
            ok: true,
            status: 202,
            headers: new Headers()
        });

        await transport.send(message);

        expect(tokenProvider).toHaveBeenCalled();
        const [, init] = (globalThis.fetch as Mock).mock.calls[0]!;
        expect(init.headers.get('Authorization')).toBe('Bearer my-bearer-token');
    });

    it('should not set Authorization header when tokenProvider returns undefined', async () => {
        const tokenProvider: TokenProvider = vi.fn(async () => undefined);
        transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), { tokenProvider });
        vi.spyOn(globalThis, 'fetch');

        const message: JSONRPCMessage = {
            jsonrpc: '2.0',
            method: 'test',
            params: {},
            id: 'test-id'
        };

        (globalThis.fetch as Mock).mockResolvedValueOnce({
            ok: true,
            status: 202,
            headers: new Headers()
        });

        await transport.send(message);

        const [, init] = (globalThis.fetch as Mock).mock.calls[0]!;
        expect(init.headers.has('Authorization')).toBe(false);
    });

    it('should throw UnauthorizedError on 401 when using tokenProvider', async () => {
        const tokenProvider: TokenProvider = vi.fn(async () => 'rejected-token');
        transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), { tokenProvider });
        vi.spyOn(globalThis, 'fetch');

        const message: JSONRPCMessage = {
            jsonrpc: '2.0',
            method: 'test',
            params: {},
            id: 'test-id'
        };

        (globalThis.fetch as Mock).mockResolvedValueOnce({
            ok: false,
            status: 401,
            headers: new Headers(),
            text: async () => 'unauthorized'
        });

        await expect(transport.send(message)).rejects.toThrow(UnauthorizedError);
        expect(tokenProvider).toHaveBeenCalledTimes(1);
    });

    it('should prefer authProvider over tokenProvider when both are set', async () => {
        const tokenProvider: TokenProvider = vi.fn(async () => 'token-provider-value');
        const authProvider = {
            get redirectUrl() {
                return 'http://localhost/callback';
            },
            get clientMetadata() {
                return { redirect_uris: ['http://localhost/callback'] };
            },
            clientInformation: vi.fn(() => ({ client_id: 'test-client-id', client_secret: 'test-secret' })),
            tokens: vi.fn(() => ({ access_token: 'auth-provider-value', token_type: 'bearer' })),
            saveTokens: vi.fn(),
            redirectToAuthorization: vi.fn(),
            saveCodeVerifier: vi.fn(),
            codeVerifier: vi.fn()
        };

        transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), { authProvider, tokenProvider });
        vi.spyOn(globalThis, 'fetch');

        const message: JSONRPCMessage = {
            jsonrpc: '2.0',
            method: 'test',
            params: {},
            id: 'test-id'
        };

        (globalThis.fetch as Mock).mockResolvedValueOnce({
            ok: true,
            status: 202,
            headers: new Headers()
        });

        await transport.send(message);

        // authProvider should be used, not tokenProvider
        expect(tokenProvider).not.toHaveBeenCalled();
        const [, init] = (globalThis.fetch as Mock).mock.calls[0]!;
        expect(init.headers.get('Authorization')).toBe('Bearer auth-provider-value');
    });

    it('should work with no auth at all', async () => {
        transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'));
        vi.spyOn(globalThis, 'fetch');

        const message: JSONRPCMessage = {
            jsonrpc: '2.0',
            method: 'test',
            params: {},
            id: 'test-id'
        };

        (globalThis.fetch as Mock).mockResolvedValueOnce({
            ok: true,
            status: 202,
            headers: new Headers()
        });

        await transport.send(message);

        const [, init] = (globalThis.fetch as Mock).mock.calls[0]!;
        expect(init.headers.has('Authorization')).toBe(false);
    });
});
