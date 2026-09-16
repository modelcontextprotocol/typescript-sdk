import {
    createFetchWithInit,
    type FetchLike,
    normalizeHeaders,
    isPrivateOrLoopbackHost,
    isSafeRedirectTarget
} from '../../src/shared/transport';

describe('normalizeHeaders', () => {
    test('returns empty object for undefined', () => {
        expect(normalizeHeaders(undefined)).toEqual({});
    });

    test('handles Headers instance', () => {
        const headers = new Headers({
            'x-foo': 'bar',
            'content-type': 'application/json'
        });
        expect(normalizeHeaders(headers)).toEqual({
            'x-foo': 'bar',
            'content-type': 'application/json'
        });
    });

    test('handles array of tuples', () => {
        const headers: [string, string][] = [
            ['x-foo', 'bar'],
            ['x-baz', 'qux']
        ];
        expect(normalizeHeaders(headers)).toEqual({
            'x-foo': 'bar',
            'x-baz': 'qux'
        });
    });

    test('handles plain object', () => {
        const headers = { 'x-foo': 'bar', 'x-baz': 'qux' };
        expect(normalizeHeaders(headers)).toEqual({
            'x-foo': 'bar',
            'x-baz': 'qux'
        });
    });

    test('returns a shallow copy for plain objects', () => {
        const headers = { 'x-foo': 'bar' };
        const result = normalizeHeaders(headers);
        expect(result).not.toBe(headers);
        expect(result).toEqual(headers);
    });
});

describe('createFetchWithInit', () => {
    test('returns baseFetch unchanged when no baseInit provided', () => {
        const mockFetch: FetchLike = vi.fn();
        const result = createFetchWithInit(mockFetch);
        expect(result).toBe(mockFetch);
    });

    test('passes baseInit to fetch when no call init provided', async () => {
        const mockFetch: FetchLike = vi.fn();
        const baseInit: RequestInit = {
            method: 'POST',
            credentials: 'include'
        };

        const wrappedFetch = createFetchWithInit(mockFetch, baseInit);
        await wrappedFetch('https://example.com');

        expect(mockFetch).toHaveBeenCalledWith(
            'https://example.com',
            expect.objectContaining({
                method: 'POST',
                credentials: 'include'
            })
        );
    });

    test('merges baseInit with call init, call init wins for non-header fields', async () => {
        const mockFetch: FetchLike = vi.fn();
        const baseInit: RequestInit = {
            method: 'POST',
            credentials: 'include'
        };

        const wrappedFetch = createFetchWithInit(mockFetch, baseInit);
        await wrappedFetch('https://example.com', { method: 'PUT' });

        expect(mockFetch).toHaveBeenCalledWith(
            'https://example.com',
            expect.objectContaining({
                method: 'PUT',
                credentials: 'include'
            })
        );
    });

    test('merges headers from both base and call init', async () => {
        const mockFetch: FetchLike = vi.fn();
        const baseInit: RequestInit = {
            headers: { 'x-base': 'base-value', 'x-shared': 'base' }
        };

        const wrappedFetch = createFetchWithInit(mockFetch, baseInit);
        await wrappedFetch('https://example.com', {
            headers: { 'x-call': 'call-value', 'x-shared': 'call' }
        });

        expect(mockFetch).toHaveBeenCalledWith(
            'https://example.com',
            expect.objectContaining({
                headers: {
                    'x-base': 'base-value',
                    'x-call': 'call-value',
                    'x-shared': 'call'
                }
            })
        );
    });

    test('uses baseInit headers when call init has no headers', async () => {
        const mockFetch: FetchLike = vi.fn();
        const baseInit: RequestInit = {
            headers: { 'x-base': 'base-value' }
        };

        const wrappedFetch = createFetchWithInit(mockFetch, baseInit);
        await wrappedFetch('https://example.com', { method: 'POST' });

        expect(mockFetch).toHaveBeenCalledWith(
            'https://example.com',
            expect.objectContaining({
                method: 'POST',
                headers: { 'x-base': 'base-value' }
            })
        );
    });

    test('handles URL object as first argument', async () => {
        const mockFetch: FetchLike = vi.fn();
        const baseInit: RequestInit = { method: 'GET' };

        const wrappedFetch = createFetchWithInit(mockFetch, baseInit);
        const url = new URL('https://example.com/path');
        await wrappedFetch(url);

        expect(mockFetch).toHaveBeenCalledWith(url, expect.objectContaining({ method: 'GET' }));
    });

    test('passes all baseInit properties when call init is empty object', async () => {
        const mockFetch: FetchLike = vi.fn();
        const baseInit: RequestInit = {
            method: 'POST',
            credentials: 'include',
            headers: { 'x-base': 'value' }
        };

        const wrappedFetch = createFetchWithInit(mockFetch, baseInit);
        await wrappedFetch('https://example.com', {});

        expect(mockFetch).toHaveBeenCalledWith(
            'https://example.com',
            expect.objectContaining({
                method: 'POST',
                credentials: 'include',
                headers: { 'x-base': 'value' }
            })
        );
    });

    test('passes Headers instance through when call init has no headers', async () => {
        const mockFetch: FetchLike = vi.fn();
        const baseHeaders = new Headers({ 'x-base': 'value' });
        const baseInit: RequestInit = {
            headers: baseHeaders
        };

        const wrappedFetch = createFetchWithInit(mockFetch, baseInit);
        await wrappedFetch('https://example.com', { method: 'POST' });

        expect(mockFetch).toHaveBeenCalledWith(
            'https://example.com',
            expect.objectContaining({
                method: 'POST',
                headers: baseHeaders
            })
        );
    });

    describe('SSRF & Redirect Protection', () => {
        test('createFetchWithInit without baseInit still applies SSRF redirect protection when given options', async () => {
            const mockFetch: FetchLike = vi.fn().mockResolvedValue(
                new Response(null, {
                    status: 307,
                    headers: { Location: 'http://127.0.0.1:8080/internal-service' }
                })
            );

            const wrappedFetch = createFetchWithInit(mockFetch, { allowLoopbackRedirects: false });
            await expect(wrappedFetch('https://api.example.com/mcp')).rejects.toThrow(
                /Insecure redirect rejected: redirection to internal\/loopback address/
            );
        });

        test('isPrivateOrLoopbackHost correctly identifies loopback and private ranges', () => {
            expect(isPrivateOrLoopbackHost('localhost')).toBe(true);
            expect(isPrivateOrLoopbackHost('127.0.0.1')).toBe(true);
            expect(isPrivateOrLoopbackHost('127.0.1.10')).toBe(true);
            expect(isPrivateOrLoopbackHost('::1')).toBe(true);
            expect(isPrivateOrLoopbackHost('[::1]')).toBe(true);
            expect(isPrivateOrLoopbackHost('169.254.169.254')).toBe(true);
            expect(isPrivateOrLoopbackHost('metadata.google.internal')).toBe(true);
            expect(isPrivateOrLoopbackHost('10.0.0.1')).toBe(true);
            expect(isPrivateOrLoopbackHost('192.168.1.1')).toBe(true);
            expect(isPrivateOrLoopbackHost('172.16.0.5')).toBe(true);
            expect(isPrivateOrLoopbackHost('172.31.255.255')).toBe(true);

            expect(isPrivateOrLoopbackHost('example.com')).toBe(false);
            expect(isPrivateOrLoopbackHost('api.anthropic.com')).toBe(false);
            expect(isPrivateOrLoopbackHost('172.32.0.1')).toBe(false);
            expect(isPrivateOrLoopbackHost('8.8.8.8')).toBe(false);
        });

        test('isSafeRedirectTarget allows public to public redirects', () => {
            expect(isSafeRedirectTarget('https://api.example.com/mcp', 'https://api.example.com/v2/mcp')).toBe(true);
            expect(isSafeRedirectTarget('https://api.example.com/mcp', 'https://cdn.other.com/mcp')).toBe(true);
        });

        test('isSafeRedirectTarget rejects public to loopback/private redirects (SSRF)', () => {
            expect(isSafeRedirectTarget('https://api.example.com/mcp', 'http://127.0.0.1:8080/secret')).toBe(false);
            expect(isSafeRedirectTarget('https://api.example.com/mcp', 'http://localhost:3000/')).toBe(false);
            expect(isSafeRedirectTarget('https://api.example.com/mcp', 'http://169.254.169.254/latest/meta-data/')).toBe(false);
            expect(isSafeRedirectTarget('https://api.example.com/mcp', 'http://10.0.0.5:8080/')).toBe(false);
        });

        test('isSafeRedirectTarget honors allowLoopback = true', () => {
            expect(isSafeRedirectTarget('https://api.example.com/mcp', 'http://127.0.0.1:8080/secret', true)).toBe(true);
        });

        test('wrappedFetch follows safe public redirect seamlessly', async () => {
            const mockFetch: FetchLike = vi
                .fn()
                .mockResolvedValueOnce(
                    new Response(null, {
                        status: 307,
                        headers: { Location: 'https://api.example.com/target' }
                    })
                )
                .mockResolvedValueOnce(
                    new Response('{"jsonrpc":"2.0","result":"ok"}', {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' }
                    })
                );

            const wrappedFetch = createFetchWithInit(mockFetch, {});
            const response = await wrappedFetch('https://api.example.com/initial');
            expect(response.status).toBe(200);
            expect(await response.text()).toBe('{"jsonrpc":"2.0","result":"ok"}');
            expect(mockFetch).toHaveBeenCalledTimes(2);
        });

        test('wrappedFetch rejects redirect to loopback from public endpoint', async () => {
            const mockFetch: FetchLike = vi.fn().mockResolvedValue(
                new Response(null, {
                    status: 307,
                    headers: { Location: 'http://127.0.0.1:8080/internal-service' }
                })
            );

            const wrappedFetch = createFetchWithInit(mockFetch, {});
            await expect(wrappedFetch('https://api.example.com/mcp')).rejects.toThrow(
                /Insecure redirect rejected: redirection to internal\/loopback address/
            );
        });
    });
});
