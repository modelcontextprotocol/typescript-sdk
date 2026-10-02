import {
    fetchLeavingRedirects,
    fetchWithinOrigin,
    isWithinOrigin,
    unfollowedRedirect,
    type FetchLike
} from '../../src/shared/transport.js';

function redirect(status: number, location: string): Response {
    return new Response(null, { status, headers: { location } });
}

/** A base fetch that answers each call with the next queued response and records what it was called with. */
function queuedFetch(...responses: Response[]) {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchFn: FetchLike = async (url, init) => {
        calls.push({ url: String(url), init });
        return responses[calls.length - 1] ?? new Response('done');
    };
    return { fetchFn, calls };
}

describe('isWithinOrigin', () => {
    const within = (from: string, to: string) => isWithinOrigin(new URL(from), new URL(to));

    it.each([
        ['the same URL', 'https://example.com/mcp', 'https://example.com/mcp'],
        ['another path on the same origin', 'https://example.com/mcp', 'https://example.com/mcp/?a=1'],
        ['a default port written out', 'https://example.com/mcp', 'https://example.com:443/mcp'],
        ['a host written in another case', 'https://example.com/mcp', 'https://EXAMPLE.com/mcp'],
        ['http to https on the same host with default ports', 'http://example.com/mcp', 'https://example.com/mcp'],
        ['http to https with both default ports written out', 'http://example.com:80/mcp', 'https://example.com:443/mcp']
    ])('accepts %s', (_name, from, to) => {
        expect(within(from, to)).toBe(true);
    });

    it.each([
        ['https to http', 'https://example.com/mcp', 'http://example.com/mcp'],
        ['another port on the same host', 'http://example.com:8080/mcp', 'http://example.com:8081/mcp'],
        ['http to https from a non-default port', 'http://example.com:8080/mcp', 'https://example.com/mcp'],
        ['http to https to a non-default port', 'http://example.com/mcp', 'https://example.com:8443/mcp'],
        ['another host', 'https://example.com/mcp', 'https://other.example.com/mcp'],
        ['http to https on another host', 'http://example.com/mcp', 'https://other.example.com/mcp'],
        ['another scheme', 'https://example.com/mcp', 'ftp://example.com/mcp']
    ])('rejects %s', (_name, from, to) => {
        expect(within(from, to)).toBe(false);
    });
});

describe('fetchWithinOrigin', () => {
    const init = { method: 'POST', headers: { 'x-custom': 'value' }, body: '{"jsonrpc":"2.0"}' };

    it('passes a response that is not a redirect through, asking the base fetch not to follow redirects', async () => {
        const { fetchFn, calls } = queuedFetch(new Response('ok', { status: 200 }));

        const response = await fetchWithinOrigin(fetchFn)('https://example.com/mcp', init);

        expect(await response.text()).toBe('ok');
        expect(calls).toEqual([{ url: 'https://example.com/mcp', init: { ...init, redirect: 'manual' } }]);
    });

    it('accepts a base fetch that returns the response without a promise', async () => {
        const ok = new Response('ok');

        const response = await fetchWithinOrigin((() => ok) as unknown as FetchLike)('https://example.com/mcp', init);

        expect(response).toBe(ok);
    });

    it.each([307, 308])('follows a %i within the origin with the same method, headers and body', async status => {
        const { fetchFn, calls } = queuedFetch(redirect(status, '/mcp/'));

        const response = await fetchWithinOrigin(fetchFn)('https://example.com/mcp', init);

        expect(response.status).toBe(200);
        expect(calls.map(call => call.url)).toEqual(['https://example.com/mcp', 'https://example.com/mcp/']);
        expect(calls[1].init).toEqual({ ...init, redirect: 'manual' });
    });

    it.each([301, 302, 303, 307, 308])('follows a %i of a GET within the origin', async status => {
        const { fetchFn, calls } = queuedFetch(redirect(status, 'https://example.com/mcp/'));

        const response = await fetchWithinOrigin(fetchFn)(new URL('https://example.com/mcp'), { headers: init.headers });

        expect(response.status).toBe(200);
        expect(calls.map(call => call.url)).toEqual(['https://example.com/mcp', 'https://example.com/mcp/']);
    });

    it('follows http to https on the same host and checks the next hop against the https URL', async () => {
        const { fetchFn, calls } = queuedFetch(redirect(307, 'https://example.com/mcp'), redirect(307, 'http://example.com/mcp'));

        const response = await fetchWithinOrigin(fetchFn)('http://example.com/mcp', init);

        expect(response.status).toBe(307);
        expect(calls.map(call => call.url)).toEqual(['http://example.com/mcp', 'https://example.com/mcp']);
    });

    it.each([301, 302, 303])('returns a %i of a POST without following it', async status => {
        const { fetchFn, calls } = queuedFetch(redirect(status, '/mcp/'));

        const response = await fetchWithinOrigin(fetchFn)('https://example.com/mcp', init);

        expect(response.status).toBe(status);
        expect(calls).toHaveLength(1);
    });

    it.each([
        ['another host', 'https://other.example.com/mcp'],
        ['another port', 'https://example.com:8443/mcp'],
        ['plain http', 'http://example.com/mcp'],
        ['a protocol-relative URL on another host', '//other.example.com/mcp'],
        ['userinfo of its own', 'https://user:pass@example.com/mcp/'],
        ['something that is not a URL', 'https://']
    ])('returns a redirect to %s without following it', async (_name, location) => {
        const { fetchFn, calls } = queuedFetch(redirect(307, location));

        const response = await fetchWithinOrigin(fetchFn)('https://example.com/mcp', init);

        expect(response.status).toBe(307);
        expect(calls).toHaveLength(1);
    });

    it('follows a relative redirect that keeps the userinfo of the request URL', async () => {
        const { fetchFn, calls } = queuedFetch(redirect(307, '/mcp/'));

        const response = await fetchWithinOrigin(fetchFn)('https://user:pass@example.com/mcp', init);

        expect(response.status).toBe(200);
        expect(calls.map(call => call.url)).toEqual(['https://user:pass@example.com/mcp', 'https://user:pass@example.com/mcp/']);
    });

    it('returns a redirect that replaces the userinfo of the request URL without following it', async () => {
        const { fetchFn, calls } = queuedFetch(redirect(307, 'https://other:pass@example.com/mcp/'));

        const response = await fetchWithinOrigin(fetchFn)('https://user:pass@example.com/mcp', init);

        expect(response.status).toBe(307);
        expect(calls).toHaveLength(1);
    });

    it('follows five redirects and returns the sixth', async () => {
        const hops = [1, 2, 3, 4, 5, 6].map(n => redirect(307, `/hop${n}`));
        const { fetchFn, calls } = queuedFetch(...hops);

        const response = await fetchWithinOrigin(fetchFn)('https://example.com/mcp', init);

        expect(response).toBe(hops[5]);
        expect(calls.map(call => call.url)).toEqual([
            'https://example.com/mcp',
            'https://example.com/hop1',
            'https://example.com/hop2',
            'https://example.com/hop3',
            'https://example.com/hop4',
            'https://example.com/hop5'
        ]);
    });

    it('returns a response that hides its redirect, as a browser does', async () => {
        const opaque = { type: 'opaqueredirect', status: 0, ok: false, headers: new Headers(), url: '' } as Response;
        const { fetchFn, calls } = queuedFetch(opaque);

        const response = await fetchWithinOrigin(fetchFn)('https://example.com/mcp', init);

        expect(response).toBe(opaque);
        expect(calls).toHaveLength(1);
        expect(unfollowedRedirect(response, 'https://example.com/mcp')).toBe(
            'Redirect not followed: this runtime does not expose the redirect target'
        );
    });

    it.each(['error', 'manual'] as const)('leaves a request that sets redirect to %s as it is', async mode => {
        const { fetchFn, calls } = queuedFetch(redirect(307, '/mcp/'));

        const response = await fetchWithinOrigin(fetchFn)('https://example.com/mcp', { ...init, redirect: mode });

        expect(response.status).toBe(307);
        expect(calls).toEqual([{ url: 'https://example.com/mcp', init: { ...init, redirect: mode } }]);
    });
});

describe('unfollowedRedirect', () => {
    it('names the target without userinfo, query or fragment', () => {
        const response = redirect(307, 'https://user:pass@other.example.com/mcp?token=abc#part');

        expect(unfollowedRedirect(response, 'https://example.com/mcp')).toBe('Redirect to https://other.example.com/mcp not followed');
    });

    it('resolves a relative target against the request URL', () => {
        expect(unfollowedRedirect(redirect(302, '/mcp/?a=1'), new URL('https://example.com/mcp'))).toBe(
            'Redirect to https://example.com/mcp/ not followed'
        );
    });

    it('suggests the https form when an https request is redirected to http', () => {
        const message = unfollowedRedirect(redirect(307, 'http://example.com/mcp/?a=1'), 'https://example.com/mcp');

        expect(message).toBe('Redirect to plain http not followed; try https://example.com/mcp/ instead');
    });

    it.each([200, 202, 304, 404, 500])('returns undefined for a %i response', status => {
        expect(
            unfollowedRedirect(new Response(null, { status, headers: { location: '/mcp/' } }), 'https://example.com/mcp')
        ).toBeUndefined();
    });

    it('returns undefined for a redirect status without a Location', () => {
        expect(unfollowedRedirect(new Response(null, { status: 307 }), 'https://example.com/mcp')).toBeUndefined();
    });
});

describe('fetchLeavingRedirects', () => {
    const init = { method: 'POST', headers: { 'x-custom': 'value' }, body: '{"jsonrpc":"2.0"}' };

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('is handed each request as it is by fetchWithinOrigin, and its redirect response is returned', async () => {
        const { fetchFn, calls } = queuedFetch(redirect(307, '/mcp/'));

        const response = await fetchWithinOrigin(fetchLeavingRedirects(fetchFn))('https://example.com/mcp', init);

        expect(response.status).toBe(307);
        expect(calls).toEqual([{ url: 'https://example.com/mcp', init }]);
        expect(calls[0].init).toBe(init);
    });

    it('uses the global fetch of the time of the request when it wraps no fetch', async () => {
        const following = fetchWithinOrigin(fetchLeavingRedirects());
        const { fetchFn, calls } = queuedFetch(new Response('ok'));
        vi.stubGlobal('fetch', fetchFn);

        const response = await following('https://example.com/mcp', init);

        expect(await response.text()).toBe('ok');
        expect(calls).toEqual([{ url: 'https://example.com/mcp', init }]);
    });

    it('leaves a fetch it has not wrapped to fetchWithinOrigin', async () => {
        const { fetchFn, calls } = queuedFetch(new Response('ok'));
        fetchLeavingRedirects(fetchFn);

        await fetchWithinOrigin(fetchFn)('https://example.com/mcp', init);

        expect(calls).toEqual([{ url: 'https://example.com/mcp', init: { ...init, redirect: 'manual' } }]);
    });
});
