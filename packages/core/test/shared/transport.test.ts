import { createFetchWithInit, type FetchLike, normalizeHeaders } from '../../src/shared/transport.js';

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
});
