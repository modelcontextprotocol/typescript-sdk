import { describe, expect, it } from 'vitest';

import {
    fetchAICatalog,
    fetchServerCard,
    getAICatalogUrl,
    SERVER_CARD_MEDIA_TYPE,
    SERVER_CARD_SCHEMA_URL,
    ServerCardError
} from '../../src/experimental/serverCard/index';
import { jsonResponse, mockFetch } from './mockFetch';

const cardUrl = 'https://weather.example.com/mcp/server-card';
const catalogUrl = 'https://example.com/.well-known/ai-catalog.json';

const card = {
    $schema: SERVER_CARD_SCHEMA_URL,
    name: 'com.example/weather',
    version: '1.0.0',
    description: 'Forecasts'
};

const catalog = {
    specVersion: '1.0',
    entries: [{ identifier: 'urn:air:example.com:mcp:weather', type: SERVER_CARD_MEDIA_TYPE, url: cardUrl }]
};

async function expectCode(promise: Promise<unknown>, code: string): Promise<ServerCardError> {
    const error = await promise.then(
        () => undefined,
        (thrown: unknown) => thrown
    );
    expect(error).toBeInstanceOf(ServerCardError);
    expect((error as ServerCardError).code).toBe(code);
    return error as ServerCardError;
}

describe('fetchServerCard', () => {
    it('sends Accept with the canonical media type and no credentials', async () => {
        const fetch = mockFetch({ [cardUrl]: () => jsonResponse(card, { contentType: SERVER_CARD_MEDIA_TYPE }) });
        const result = await fetchServerCard(cardUrl, { fetch });
        expect(result).toMatchObject({ notModified: false, card, url: cardUrl });
        expect(fetch.calls).toHaveLength(1);
        expect(new Headers(fetch.calls[0]!.init!.headers).get('Accept')).toBe(SERVER_CARD_MEDIA_TYPE);
        expect(fetch.calls[0]!.init!.credentials).toBe('omit');
        expect(fetch.calls[0]!.init!.redirect).toBe('manual');
    });

    it('accepts bare application/json and media type parameters', async () => {
        for (const contentType of ['application/json', 'application/json; charset=utf-8', `${SERVER_CARD_MEDIA_TYPE}; charset=utf-8`]) {
            const fetch = mockFetch({ [cardUrl]: () => jsonResponse(card, { contentType }) });
            const result = await fetchServerCard(cardUrl, { fetch });
            expect(result.notModified).toBe(false);
        }
    });

    it('rejects other media types with the offending essence', async () => {
        const fetch = mockFetch({ [cardUrl]: () => jsonResponse(card, { contentType: 'text/html' }) });
        const error = await expectCode(fetchServerCard(cardUrl, { fetch }), 'invalid-media-type');
        expect(error.mediaType).toBe('text/html');
    });

    it('defaults a missing $schema but rejects a wrong one', async () => {
        const { $schema: _schema, ...cardWithoutSchema } = card;
        const lenient = mockFetch({ [cardUrl]: () => jsonResponse(cardWithoutSchema, { contentType: SERVER_CARD_MEDIA_TYPE }) });
        const result = await fetchServerCard(cardUrl, { fetch: lenient });
        expect(result.notModified).toBe(false);
        expect(!result.notModified && result.card.$schema).toBe(SERVER_CARD_SCHEMA_URL);

        const wrong = mockFetch({
            [cardUrl]: () => jsonResponse({ ...card, $schema: 'https://example.com/other.json' }, { contentType: SERVER_CARD_MEDIA_TYPE })
        });
        await expectCode(fetchServerCard(cardUrl, { fetch: wrong }), 'invalid-server-card');
    });

    it('rejects an invalid card with the ZodError as cause', async () => {
        const fetch = mockFetch({ [cardUrl]: () => jsonResponse({ ...card, name: 'no-slash' }, { contentType: SERVER_CARD_MEDIA_TYPE }) });
        const error = await expectCode(fetchServerCard(cardUrl, { fetch }), 'invalid-server-card');
        expect(error.cause).toBeDefined();
    });

    it('throws invalid-url, before any request, for a string that does not parse as a URL', async () => {
        const fetch = mockFetch({});
        const error = await expectCode(fetchServerCard('https://exa mple.com/card', { fetch }), 'invalid-url');
        expect(error.cause).toBeDefined();
        expect(fetch.calls).toHaveLength(0);
    });

    it('throws http-error with status for non-2xx responses', async () => {
        const fetch = mockFetch({ [cardUrl]: () => new Response('down', { status: 503 }) });
        const error = await expectCode(fetchServerCard(cardUrl, { fetch }), 'http-error');
        expect(error.status).toBe(503);
        expect(error.url).toBe(cardUrl);
    });

    it('enforces the response size cap on streamed bodies', async () => {
        const fetch = mockFetch({
            [cardUrl]: () => new Response('x'.repeat(2048), { headers: { 'Content-Type': SERVER_CARD_MEDIA_TYPE } })
        });
        await expectCode(fetchServerCard(cardUrl, { fetch, maxResponseBytes: 1024 }), 'response-too-large');
        const underCap = mockFetch({ [cardUrl]: () => jsonResponse(card, { contentType: SERVER_CARD_MEDIA_TYPE }) });
        await expect(fetchServerCard(cardUrl, { fetch: underCap, maxResponseBytes: 1024 })).resolves.toMatchObject({ notModified: false });
    });

    it('follows redirects up to the cap and re-guards every hop', async () => {
        const hop = (location: string) => new Response(null, { status: 302, headers: { Location: location } });
        const fetch = mockFetch({
            'https://a.example.com/card': () => hop('https://b.example.com/card'),
            'https://b.example.com/card': () => jsonResponse(card, { contentType: SERVER_CARD_MEDIA_TYPE })
        });
        const result = await fetchServerCard('https://a.example.com/card', { fetch });
        expect(!result.notModified && result.url).toBe('https://b.example.com/card');

        const looping = mockFetch({
            'https://a.example.com/card': () => hop('https://a.example.com/card')
        });
        await expectCode(fetchServerCard('https://a.example.com/card', { fetch: looping, maxRedirects: 2 }), 'too-many-redirects');

        const intoMetadata = mockFetch({
            'https://a.example.com/card': () => hop('http://169.254.169.254/latest/meta-data')
        });
        await expectCode(fetchServerCard('https://a.example.com/card', { fetch: intoMetadata }), 'blocked-host');
    });

    it('returns notModified with cache validators on 304', async () => {
        const fetch = mockFetch({
            [cardUrl]: request => {
                expect(new Headers(request.init!.headers).get('If-None-Match')).toBe('"abc"');
                return new Response(null, { status: 304, headers: { ETag: '"abc"', 'Cache-Control': 'public, max-age=3600' } });
            }
        });
        const result = await fetchServerCard(cardUrl, { fetch, etag: '"abc"' });
        expect(result).toEqual({ notModified: true, etag: '"abc"', cacheControl: 'public, max-age=3600' });
    });

    it('passes response etag and cacheControl through so the caller owns the cache', async () => {
        const fetch = mockFetch({
            [cardUrl]: () =>
                jsonResponse(card, { contentType: SERVER_CARD_MEDIA_TYPE, headers: { ETag: '"v1"', 'Cache-Control': 'max-age=60' } })
        });
        const result = await fetchServerCard(cardUrl, { fetch });
        expect(result).toMatchObject({ etag: '"v1"', cacheControl: 'max-age=60' });
    });
});

describe('fetchAICatalog', () => {
    it('fetches and validates a catalog with its media type', async () => {
        const fetch = mockFetch({ [catalogUrl]: () => jsonResponse(catalog, { contentType: 'application/ai-catalog+json' }) });
        const result = await fetchAICatalog(catalogUrl, { fetch });
        expect(result).toMatchObject({ notModified: false, catalog, url: catalogUrl });
        expect(new Headers(fetch.calls[0]!.init!.headers).get('Accept')).toBe('application/ai-catalog+json');
    });

    it('rejects an invalid catalog document', async () => {
        const fetch = mockFetch({ [catalogUrl]: () => jsonResponse({ entries: [] }) });
        await expectCode(fetchAICatalog(catalogUrl, { fetch }), 'invalid-ai-catalog');
    });

    it('truncates entries beyond maxEntries instead of throwing', async () => {
        const entries = Array.from({ length: 5 }, (_, index) => ({
            identifier: `urn:air:example.com:mcp:s${index}`,
            type: SERVER_CARD_MEDIA_TYPE,
            url: `https://example.com/${index}`
        }));
        const fetch = mockFetch({ [catalogUrl]: () => jsonResponse({ specVersion: '1.0', entries }) });
        const result = await fetchAICatalog(catalogUrl, { fetch, maxEntries: 2 });
        expect(!result.notModified && result.catalog.entries).toHaveLength(2);
    });
});

describe('getAICatalogUrl', () => {
    it('prefixes bare domains with https and appends the well-known path', () => {
        expect(getAICatalogUrl('example.com').href).toBe('https://example.com/.well-known/ai-catalog.json');
        expect(getAICatalogUrl('localhost:3000').href).toBe('https://localhost:3000/.well-known/ai-catalog.json');
    });

    it('keeps the origin of full URLs and drops their path', () => {
        expect(getAICatalogUrl('https://example.com/some/page').href).toBe('https://example.com/.well-known/ai-catalog.json');
        expect(getAICatalogUrl(new URL('http://localhost:8080/mcp')).href).toBe('http://localhost:8080/.well-known/ai-catalog.json');
    });
});
