import { describe, expect, it } from 'vitest';

import type { AICatalogEntry, ServerCardError } from '../../src/experimental/serverCard/index';
import { discoverServerCards, SERVER_CARD_MEDIA_TYPE, SERVER_CARD_SCHEMA_URL } from '../../src/experimental/serverCard/index';
import { jsonResponse, mockFetch } from './mockFetch';

const catalogUrl = 'https://example.com/.well-known/ai-catalog.json';
const cardUrl = 'https://mcp-host.example.net/mcp/server-card';

const card = {
    $schema: SERVER_CARD_SCHEMA_URL,
    name: 'com.example/weather',
    version: '1.0.0',
    description: 'Forecasts',
    remotes: [{ type: 'streamable-http', url: 'https://mcp-host.example.net/mcp' }]
};

const urlEntry = { identifier: 'urn:air:example.com:mcp:weather', type: SERVER_CARD_MEDIA_TYPE, url: cardUrl };

function catalogOf(entries: unknown[]): unknown {
    return { specVersion: '1.0', entries };
}

describe('discoverServerCards', () => {
    it('returns [] for a missing catalog (404) and a gone catalog (410)', async () => {
        for (const status of [404, 410]) {
            const fetch = mockFetch({ [catalogUrl]: () => new Response('gone', { status }) });
            await expect(discoverServerCards('example.com', { fetch })).resolves.toEqual([]);
        }
    });

    it('throws for other catalog failures', async () => {
        const fetch = mockFetch({ [catalogUrl]: () => new Response('err', { status: 500 }) });
        await expect(discoverServerCards('example.com', { fetch })).rejects.toMatchObject({ code: 'http-error', status: 500 });
    });

    it('follows url entries and assembles listing-chain provenance', async () => {
        const fetch = mockFetch({
            [catalogUrl]: () => jsonResponse(catalogOf([urlEntry])),
            [cardUrl]: () => jsonResponse(card, { contentType: SERVER_CARD_MEDIA_TYPE })
        });
        const hits = await discoverServerCards('example.com', { fetch });
        expect(hits).toHaveLength(1);
        expect(hits[0]).toMatchObject({
            card,
            entry: urlEntry,
            catalogUrl,
            listingDomain: 'example.com',
            cardUrl,
            hostingDomain: 'mcp-host.example.net'
        });
    });

    it('parses inline data entries with zero extra fetches and no hosting domain', async () => {
        const inlineEntry = { identifier: urlEntry.identifier, type: SERVER_CARD_MEDIA_TYPE, data: card };
        const fetch = mockFetch({ [catalogUrl]: () => jsonResponse(catalogOf([inlineEntry])) });
        const hits = await discoverServerCards('example.com', { fetch });
        expect(hits).toHaveLength(1);
        expect(hits[0]!.card).toEqual(card);
        expect(hits[0]!.cardUrl).toBeUndefined();
        expect(hits[0]!.hostingDomain).toBeUndefined();
        expect(fetch.calls).toHaveLength(1);
    });

    it('applies lenient $schema ingestion to inline entries', async () => {
        const { $schema: _schema, ...inlineCard } = card;
        const inlineEntry = { identifier: urlEntry.identifier, type: SERVER_CARD_MEDIA_TYPE, data: inlineCard };
        const fetch = mockFetch({ [catalogUrl]: () => jsonResponse(catalogOf([inlineEntry])) });
        const hits = await discoverServerCards('example.com', { fetch });
        expect(hits[0]!.card.$schema).toBe(SERVER_CARD_SCHEMA_URL);
    });

    it('skips entries of other types silently', async () => {
        const agentEntry = {
            identifier: 'urn:air:example.com:agent:helper',
            type: 'application/agent-card+json',
            url: 'https://x.example/a'
        };
        const fetch = mockFetch({
            [catalogUrl]: () => jsonResponse(catalogOf([agentEntry, urlEntry])),
            [cardUrl]: () => jsonResponse(card, { contentType: SERVER_CARD_MEDIA_TYPE })
        });
        const hits = await discoverServerCards('example.com', { fetch });
        expect(hits).toHaveLength(1);
        expect(fetch.calls.map(call => call.url)).toEqual([catalogUrl, cardUrl]);
    });

    it('reports per-entry failures via onEntryError and continues the walk', async () => {
        const badEntry = {
            identifier: 'urn:air:example.com:mcp:broken',
            type: SERVER_CARD_MEDIA_TYPE,
            url: 'https://broken.example.net/card'
        };
        const invalidInline = { identifier: 'urn:air:example.com:mcp:bad-inline', type: SERVER_CARD_MEDIA_TYPE, data: { nope: true } };
        const fetch = mockFetch({
            [catalogUrl]: () => jsonResponse(catalogOf([badEntry, invalidInline, urlEntry])),
            'https://broken.example.net/card': () => new Response('down', { status: 500 }),
            [cardUrl]: () => jsonResponse(card, { contentType: SERVER_CARD_MEDIA_TYPE })
        });
        const failures: Array<{ code: string; identifier: string }> = [];
        const hits = await discoverServerCards('example.com', {
            fetch,
            onEntryError: (error: ServerCardError, entry: AICatalogEntry) =>
                failures.push({ code: error.code, identifier: entry.identifier })
        });
        expect(hits).toHaveLength(1);
        expect(failures).toEqual([
            { code: 'http-error', identifier: 'urn:air:example.com:mcp:broken' },
            { code: 'invalid-server-card', identifier: 'urn:air:example.com:mcp:bad-inline' }
        ]);
    });

    it('caps processed card entries at maxEntries', async () => {
        const entries = Array.from({ length: 4 }, (_, index) => ({
            identifier: `urn:air:example.com:mcp:s${index}`,
            type: SERVER_CARD_MEDIA_TYPE,
            data: card
        }));
        const fetch = mockFetch({ [catalogUrl]: () => jsonResponse(catalogOf(entries)) });
        const hits = await discoverServerCards('example.com', { fetch, maxEntries: 2 });
        expect(hits).toHaveLength(2);
    });

    it('accepts a full URL and probes its origin', async () => {
        const fetch = mockFetch({ [catalogUrl]: () => jsonResponse(catalogOf([])) });
        await expect(discoverServerCards('https://example.com/deep/page', { fetch })).resolves.toEqual([]);
        expect(fetch.calls[0]!.url).toBe(catalogUrl);
    });
});
