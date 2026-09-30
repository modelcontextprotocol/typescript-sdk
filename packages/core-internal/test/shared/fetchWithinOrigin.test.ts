import type { FetchLike } from '../../src/shared/transport';
import { fetchLeavingRedirects, fetchWithinOrigin, isWithinOrigin, unfollowedRedirect } from '../../src/shared/transport';

const redirect = (location: string, status = 307) => new Response(null, { status, headers: { location } });
const opaqueRedirect = { type: 'opaqueredirect', status: 0, ok: false, headers: new Headers() } as Response;

describe('isWithinOrigin', () => {
    test.each([
        ['https://example.com/mcp', 'https://example.com/mcp', true],
        ['https://example.com/mcp', 'https://example.com/mcp/?a=1', true],
        ['http://example.com:8080/mcp', 'http://example.com:8080/other', true],
        ['http://example.com/mcp', 'https://example.com/mcp', true],
        ['http://example.com:80/mcp', 'https://example.com:443/mcp', true],
        ['https://example.com/mcp', 'http://example.com/mcp', false],
        ['https://example.com/mcp', 'https://example.com:8443/mcp', false],
        ['http://example.com:8080/mcp', 'https://example.com/mcp', false],
        ['http://example.com/mcp', 'https://example.com:8443/mcp', false],
        ['https://example.com/mcp', 'https://other.example/mcp', false],
        ['http://example.com/mcp', 'https://other.example/mcp', false],
        ['https://example.com/mcp', 'https://sub.example.com/mcp', false]
    ])('from %s to %s is %s', (from, to, expected) => {
        expect(isWithinOrigin(new URL(from), new URL(to))).toBe(expected);
    });
});

describe('fetchWithinOrigin', () => {
    const init = { method: 'POST', headers: { 'x-api-key': 'key-1' }, body: '{"id":1}' };

    /** A fetch that answers from `responses` by URL, and 200 for any URL not listed. */
    const fetchAnswering = (responses: Record<string, () => Response>) =>
        vi.fn<FetchLike>(async url => responses[String(url)]?.() ?? new Response('ok'));
    const requested = (baseFetch: ReturnType<typeof fetchAnswering>) => baseFetch.mock.calls.map(([url]) => String(url));

    test('hands the url and init to the base fetch and returns its response', async () => {
        const response = new Response('ok');
        const baseFetch = vi.fn<FetchLike>(async () => response);
        const url = new URL('https://example.com/mcp');

        await expect(fetchWithinOrigin(baseFetch)(url, init)).resolves.toBe(response);

        expect(baseFetch).toHaveBeenCalledTimes(1);
        expect(baseFetch.mock.calls[0]![0]).toBe(url);
        expect(baseFetch.mock.calls[0]![1]).toEqual({ ...init, redirect: 'manual' });
    });

    test.each([307, 308])('follows a %i within the origin with the same method, headers and body', async status => {
        const baseFetch = fetchAnswering({ 'https://example.com/mcp': () => redirect('/mcp/', status) });

        const response = await fetchWithinOrigin(baseFetch)('https://example.com/mcp', init);

        expect(response.status).toBe(200);
        expect(requested(baseFetch)).toEqual(['https://example.com/mcp', 'https://example.com/mcp/']);
        expect(baseFetch.mock.calls[1]![1]).toEqual({ ...init, redirect: 'manual' });
    });

    test.each([301, 302, 303, 307, 308])('follows a %i of a GET within the origin', async status => {
        const baseFetch = fetchAnswering({ 'https://example.com/mcp': () => redirect('https://example.com/mcp/', status) });

        const response = await fetchWithinOrigin(baseFetch)('https://example.com/mcp', { headers: init.headers });

        expect(response.status).toBe(200);
        expect(requested(baseFetch)).toEqual(['https://example.com/mcp', 'https://example.com/mcp/']);
    });

    test.each([301, 302, 303])('returns a %i of a POST without following it', async status => {
        const baseFetch = fetchAnswering({ 'https://example.com/mcp': () => redirect('/mcp/', status) });

        const response = await fetchWithinOrigin(baseFetch)('https://example.com/mcp', init);

        expect(response.status).toBe(status);
        expect(requested(baseFetch)).toEqual(['https://example.com/mcp']);
    });

    test('follows from http to https on the same host and default ports', async () => {
        const baseFetch = fetchAnswering({ 'http://example.com/mcp': () => redirect('https://example.com/mcp') });

        const response = await fetchWithinOrigin(baseFetch)('http://example.com/mcp', init);

        expect(response.status).toBe(200);
        expect(requested(baseFetch)).toEqual(['http://example.com/mcp', 'https://example.com/mcp']);
    });

    test.each([
        'https://other.example/mcp',
        'https://example.com:8443/mcp',
        'http://example.com/mcp',
        '//other.example/mcp',
        'https://user:pass@example.com/mcp/',
        'ftp://example.com/mcp',
        'http://['
    ])('returns a redirect to %s without following it', async location => {
        const baseFetch = fetchAnswering({ 'https://example.com/mcp': () => redirect(location) });

        const response = await fetchWithinOrigin(baseFetch)('https://example.com/mcp', init);

        expect(response.status).toBe(307);
        expect(requested(baseFetch)).toEqual(['https://example.com/mcp']);
    });

    test('follows a relative Location that keeps the userinfo of the requested url', async () => {
        const baseFetch = fetchAnswering({ 'https://user:pass@example.com/mcp': () => redirect('/mcp/') });

        const response = await fetchWithinOrigin(baseFetch)('https://user:pass@example.com/mcp', init);

        expect(response.status).toBe(200);
        expect(requested(baseFetch)).toEqual(['https://user:pass@example.com/mcp', 'https://user:pass@example.com/mcp/']);
    });

    test('returns a Location with userinfo other than that of the requested url without following it', async () => {
        const baseFetch = fetchAnswering({ 'https://user:pass@example.com/mcp': () => redirect('https://other:pass@example.com/mcp/') });

        const response = await fetchWithinOrigin(baseFetch)('https://user:pass@example.com/mcp', init);

        expect(response.status).toBe(307);
        expect(requested(baseFetch)).toEqual(['https://user:pass@example.com/mcp']);
    });

    test('follows five redirects and returns the sixth', async () => {
        const baseFetch = vi.fn<FetchLike>(async url => redirect(`/hop/${Number(String(url).split('/').pop()) + 1}`));

        const response = await fetchWithinOrigin(baseFetch)('https://example.com/hop/0', init);

        expect(response.status).toBe(307);
        expect(response.headers.get('location')).toBe('/hop/6');
        expect(baseFetch).toHaveBeenCalledTimes(6);
    });

    test('returns a redirect response without a readable Location as it is', async () => {
        const baseFetch = vi.fn<FetchLike>(async () => opaqueRedirect);

        await expect(fetchWithinOrigin(baseFetch)('https://example.com/mcp', init)).resolves.toBe(opaqueRedirect);
        expect(baseFetch).toHaveBeenCalledTimes(1);
    });
});

describe('unfollowedRedirect', () => {
    test('is undefined for a response that is not a redirect', () => {
        expect(unfollowedRedirect('https://example.com/mcp', new Response('ok'))).toBeUndefined();
        expect(unfollowedRedirect('https://example.com/mcp', new Response(null, { status: 404 }))).toBeUndefined();
    });

    test('names the target without userinfo, query or fragment', () => {
        const text = unfollowedRedirect('https://example.com/mcp', redirect('https://user:pass@other.example/mcp?a=1#b'));

        expect(text).toBe('Redirect to https://other.example/mcp not followed; use that URL as the endpoint if it is the intended server');
    });

    test('resolves a relative Location against the requested url', () => {
        const text = unfollowedRedirect('https://example.com/mcp', redirect('/mcp/', 302));

        expect(text).toContain('Redirect to https://example.com/mcp/ not followed');
    });

    test('names the https form of a plain http target of an https request', () => {
        const text = unfollowedRedirect('https://example.com/mcp', redirect('http://example.com/mcp/?a=1'));

        expect(text).toBe('Redirect from https to plain http not followed; try https://example.com/mcp/ as the endpoint');
    });

    test('describes a redirect response that does not expose its target', () => {
        expect(unfollowedRedirect('https://example.com/mcp', opaqueRedirect)).toBe(
            'Redirect not followed: this runtime does not expose where it points'
        );
    });
});

describe('fetchLeavingRedirects', () => {
    const init = { method: 'POST', headers: { 'x-api-key': 'key-1' }, body: '{"id":1}' };

    test('is returned by fetchWithinOrigin as it is, and hands the url and init to the base fetch', async () => {
        const response = redirect('/mcp/');
        const baseFetch = vi.fn<FetchLike>(async () => response);
        const leaving = fetchLeavingRedirects(baseFetch);
        const url = new URL('https://example.com/mcp');

        expect(fetchWithinOrigin(leaving)).toBe(leaving);
        await expect(leaving(url, init)).resolves.toBe(response);

        expect(baseFetch).toHaveBeenCalledTimes(1);
        expect(baseFetch.mock.calls[0]![0]).toBe(url);
        expect(baseFetch.mock.calls[0]![1]).toBe(init);
    });

    test('leaves the base fetch as fetchWithinOrigin wraps it', async () => {
        const baseFetch = vi.fn<FetchLike>(async () => new Response('ok'));
        fetchLeavingRedirects(baseFetch);

        await fetchWithinOrigin(baseFetch)('https://example.com/mcp', init);

        expect(baseFetch.mock.calls[0]![1]).toEqual({ ...init, redirect: 'manual' });
    });
});
