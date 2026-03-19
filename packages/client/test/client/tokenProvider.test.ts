import type { JSONRPCMessage } from '@modelcontextprotocol/core';
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/core';
import type { Mock } from 'vitest';

import type { AuthProvider } from '../../src/client/auth.js';
import { UnauthorizedError } from '../../src/client/auth.js';
import { StreamableHTTPClientTransport } from '../../src/client/streamableHttp.js';

describe('StreamableHTTPClientTransport with AuthProvider', () => {
    let transport: StreamableHTTPClientTransport;

    afterEach(async () => {
        await transport?.close().catch(() => {});
        vi.clearAllMocks();
    });

    const message: JSONRPCMessage = { jsonrpc: '2.0', method: 'test', params: {}, id: 'test-id' };

    it('should set Authorization header from AuthProvider.token()', async () => {
        const authProvider: AuthProvider = { token: vi.fn(async () => 'my-bearer-token') };
        transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), { authProvider });
        vi.spyOn(globalThis, 'fetch');

        (globalThis.fetch as Mock).mockResolvedValueOnce({ ok: true, status: 202, headers: new Headers() });

        await transport.send(message);

        expect(authProvider.token).toHaveBeenCalled();
        const [, init] = (globalThis.fetch as Mock).mock.calls[0]!;
        expect(init.headers.get('Authorization')).toBe('Bearer my-bearer-token');
    });

    it('should not set Authorization header when token() returns undefined', async () => {
        const authProvider: AuthProvider = { token: vi.fn(async () => undefined) };
        transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), { authProvider });
        vi.spyOn(globalThis, 'fetch');

        (globalThis.fetch as Mock).mockResolvedValueOnce({ ok: true, status: 202, headers: new Headers() });

        await transport.send(message);

        const [, init] = (globalThis.fetch as Mock).mock.calls[0]!;
        expect(init.headers.has('Authorization')).toBe(false);
    });

    it('should throw UnauthorizedError on 401 when onUnauthorized is not provided', async () => {
        const authProvider: AuthProvider = { token: vi.fn(async () => 'rejected-token') };
        transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), { authProvider });
        vi.spyOn(globalThis, 'fetch');

        (globalThis.fetch as Mock).mockResolvedValueOnce({
            ok: false,
            status: 401,
            headers: new Headers(),
            text: async () => 'unauthorized'
        });

        await expect(transport.send(message)).rejects.toThrow(UnauthorizedError);
        expect(authProvider.token).toHaveBeenCalledTimes(1);
    });

    it('should call onUnauthorized and retry once on 401', async () => {
        let currentToken = 'old-token';
        const authProvider: AuthProvider = {
            token: vi.fn(async () => currentToken),
            onUnauthorized: vi.fn(async () => {
                currentToken = 'new-token';
            })
        };
        transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), { authProvider });
        vi.spyOn(globalThis, 'fetch');

        (globalThis.fetch as Mock)
            .mockResolvedValueOnce({ ok: false, status: 401, headers: new Headers(), text: async () => 'unauthorized' })
            .mockResolvedValueOnce({ ok: true, status: 202, headers: new Headers() });

        await transport.send(message);

        expect(authProvider.onUnauthorized).toHaveBeenCalledTimes(1);
        expect(authProvider.token).toHaveBeenCalledTimes(2);
        const [, retryInit] = (globalThis.fetch as Mock).mock.calls[1]!;
        expect(retryInit.headers.get('Authorization')).toBe('Bearer new-token');
    });

    it('should throw SdkError(ClientHttpAuthentication) if retry after onUnauthorized also gets 401', async () => {
        const authProvider: AuthProvider = {
            token: vi.fn(async () => 'still-bad'),
            onUnauthorized: vi.fn(async () => {})
        };
        transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), { authProvider });
        vi.spyOn(globalThis, 'fetch');

        (globalThis.fetch as Mock)
            .mockResolvedValueOnce({ ok: false, status: 401, headers: new Headers(), text: async () => 'unauthorized' })
            .mockResolvedValueOnce({ ok: false, status: 401, headers: new Headers(), text: async () => 'unauthorized' });

        const error = await transport.send(message).catch(e => e);
        expect(error).toBeInstanceOf(SdkError);
        expect((error as SdkError).code).toBe(SdkErrorCode.ClientHttpAuthentication);
        expect(authProvider.onUnauthorized).toHaveBeenCalledTimes(1);
    });

    it('should reset retry guard when onUnauthorized throws, allowing retry on next send', async () => {
        const authProvider: AuthProvider = {
            token: vi.fn(async () => 'token'),
            onUnauthorized: vi.fn().mockRejectedValueOnce(new Error('transient network error')).mockResolvedValueOnce(undefined)
        };
        transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), { authProvider });
        vi.spyOn(globalThis, 'fetch');

        (globalThis.fetch as Mock)
            .mockResolvedValueOnce({ ok: false, status: 401, headers: new Headers(), text: async () => 'unauthorized' })
            .mockResolvedValueOnce({ ok: false, status: 401, headers: new Headers(), text: async () => 'unauthorized' })
            .mockResolvedValueOnce({ ok: true, status: 202, headers: new Headers() });

        // First send: onUnauthorized throws transient error
        await expect(transport.send(message)).rejects.toThrow('transient network error');
        expect(authProvider.onUnauthorized).toHaveBeenCalledTimes(1);

        // Second send: flag should be reset, so onUnauthorized gets a second chance
        await transport.send(message);
        expect(authProvider.onUnauthorized).toHaveBeenCalledTimes(2);
    });

    it('should work with no authProvider at all', async () => {
        transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'));
        vi.spyOn(globalThis, 'fetch');

        (globalThis.fetch as Mock).mockResolvedValueOnce({ ok: true, status: 202, headers: new Headers() });

        await transport.send(message);

        const [, init] = (globalThis.fetch as Mock).mock.calls[0]!;
        expect(init.headers.has('Authorization')).toBe(false);
    });

    it('should throw when finishAuth is called with a non-OAuth AuthProvider', async () => {
        const authProvider: AuthProvider = { token: async () => 'api-key' };
        transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), { authProvider });

        await expect(transport.finishAuth('auth-code')).rejects.toThrow('finishAuth requires an OAuthClientProvider');
    });

    it('should throw UnauthorizedError on GET-SSE 401 with no onUnauthorized (via resumeStream)', async () => {
        const authProvider: AuthProvider = { token: async () => 'api-key' };
        transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), { authProvider });
        vi.spyOn(globalThis, 'fetch');

        (globalThis.fetch as Mock).mockResolvedValueOnce({
            ok: false,
            status: 401,
            headers: new Headers(),
            text: async () => 'unauthorized'
        });

        await expect(transport.resumeStream('last-event-id')).rejects.toThrow(UnauthorizedError);
    });

    it('should call onUnauthorized and retry on GET-SSE 401 (via resumeStream)', async () => {
        let currentToken = 'old-token';
        const authProvider: AuthProvider = {
            token: vi.fn(async () => currentToken),
            onUnauthorized: vi.fn(async () => {
                currentToken = 'new-token';
            })
        };
        transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), { authProvider });
        vi.spyOn(globalThis, 'fetch');

        // First GET: 401. Second GET (retry): 405 (server doesn't offer SSE — clean exit)
        (globalThis.fetch as Mock)
            .mockResolvedValueOnce({ ok: false, status: 401, headers: new Headers(), text: async () => 'unauthorized' })
            .mockResolvedValueOnce({ ok: false, status: 405, headers: new Headers(), text: async () => '' });

        await transport.resumeStream('last-event-id');

        expect(authProvider.onUnauthorized).toHaveBeenCalledTimes(1);
        expect(authProvider.token).toHaveBeenCalledTimes(2);
        const [, retryInit] = (globalThis.fetch as Mock).mock.calls[1]!;
        expect(retryInit.headers.get('Authorization')).toBe('Bearer new-token');
    });
});
