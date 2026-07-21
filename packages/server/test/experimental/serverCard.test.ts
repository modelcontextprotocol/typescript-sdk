import type { Implementation } from '@modelcontextprotocol/core-internal';
import { describe, expect, it } from 'vitest';

import type { AICatalog, ServerCard } from '../../src/experimental/serverCard';
import {
    AI_CATALOG_MEDIA_TYPE,
    aiCatalogResponse,
    buildAICatalog,
    buildServerCard,
    getServerCardUrl,
    SERVER_CARD_MEDIA_TYPE,
    SERVER_CARD_SCHEMA_URL,
    serverCardCatalogEntry,
    serverCardResponse
} from '../../src/experimental/serverCard';

const mcpUrl = new URL('https://weather.example.com/mcp');

const card: ServerCard = buildServerCard({
    name: 'com.example/weather',
    description: 'Hourly and 7-day forecasts for any coordinates',
    version: '1.2.3',
    remotes: [{ type: 'streamable-http', url: mcpUrl.href }]
});

const catalog: AICatalog = buildAICatalog({
    entries: [serverCardCatalogEntry(card, { url: getServerCardUrl(mcpUrl) })]
});

describe('buildServerCard', () => {
    it('pins $schema and validates the card', () => {
        expect(card.$schema).toBe(SERVER_CARD_SCHEMA_URL);
        expect(card.name).toBe('com.example/weather');
    });

    it('prefills version, title, websiteUrl, and icons from serverInfo', () => {
        const serverInfo: Implementation = {
            name: 'weather',
            version: '9.9.9',
            title: 'Weather',
            websiteUrl: 'https://example.com',
            icons: [{ src: 'https://example.com/icon.png' }]
        };
        const built = buildServerCard({ name: 'com.example/weather', description: 'Forecasts', serverInfo });
        expect(built.version).toBe('9.9.9');
        expect(built.title).toBe('Weather');
        expect(built.websiteUrl).toBe('https://example.com');
        expect(built.icons).toEqual([{ src: 'https://example.com/icon.png' }]);
    });

    it('prefers explicit options over serverInfo prefills', () => {
        const serverInfo: Implementation = { name: 'weather', version: '9.9.9', title: 'Prefilled' };
        const built = buildServerCard({
            name: 'com.example/weather',
            description: 'Forecasts',
            serverInfo,
            version: '1.0.0',
            title: 'Explicit'
        });
        expect(built.version).toBe('1.0.0');
        expect(built.title).toBe('Explicit');
    });

    it('throws at build time on constraint violations', () => {
        expect(() => buildServerCard({ name: 'no-slash', description: 'Forecasts', version: '1.0.0' })).toThrow();
        expect(() => buildServerCard({ name: 'com.example/weather', description: 'x'.repeat(101), version: '1.0.0' })).toThrow();
        expect(() => buildServerCard({ name: 'com.example/weather', description: 'Forecasts', version: '^1.2.3' })).toThrow();
        // No version anywhere: the composed parse rejects the missing field.
        expect(() => buildServerCard({ name: 'com.example/weather', description: 'Forecasts' })).toThrow();
    });
});

describe('getServerCardUrl', () => {
    it('appends /server-card to the MCP path', () => {
        expect(getServerCardUrl('https://weather.example.com/mcp')).toBe('https://weather.example.com/mcp/server-card');
    });

    it('tolerates a trailing slash on the MCP URL', () => {
        expect(getServerCardUrl('https://weather.example.com/mcp/')).toBe('https://weather.example.com/mcp/server-card');
    });

    it('serves from the root path for a root MCP URL', () => {
        expect(getServerCardUrl('https://weather.example.com/')).toBe('https://weather.example.com/server-card');
    });
});

describe('serverCardResponse', () => {
    it('returns undefined synchronously for unmatched paths and the bare MCP endpoint', () => {
        expect(serverCardResponse(new Request('https://weather.example.com/mcp'), { card, mcpUrl })).toBeUndefined();
        expect(serverCardResponse(new Request('https://weather.example.com/other'), { card, mcpUrl })).toBeUndefined();
    });

    it('serves the card with media type, CORS, and default Cache-Control', async () => {
        const response = await serverCardResponse(new Request('https://weather.example.com/mcp/server-card'), { card, mcpUrl });
        expect(response!.status).toBe(200);
        expect(response!.headers.get('Content-Type')).toBe(SERVER_CARD_MEDIA_TYPE);
        expect(response!.headers.get('Access-Control-Allow-Origin')).toBe('*');
        expect(response!.headers.get('Cache-Control')).toBe('public, max-age=3600');
        expect(await response!.json()).toEqual(card);
    });

    it('tolerates a trailing slash on the request and on the MCP URL', async () => {
        const withSlash = await serverCardResponse(new Request('https://weather.example.com/mcp/server-card/'), { card, mcpUrl });
        expect(withSlash!.status).toBe(200);
        const slashMcp = await serverCardResponse(new Request('https://weather.example.com/mcp/server-card'), {
            card,
            mcpUrl: 'https://weather.example.com/mcp/'
        });
        expect(slashMcp!.status).toBe(200);
    });

    it('answers OPTIONS with 204, reflected headers, and Vary', async () => {
        const response = await serverCardResponse(
            new Request('https://weather.example.com/mcp/server-card', {
                method: 'OPTIONS',
                headers: { 'Access-Control-Request-Headers': 'if-none-match' }
            }),
            { card, mcpUrl }
        );
        expect(response!.status).toBe(204);
        expect(response!.headers.get('Access-Control-Allow-Origin')).toBe('*');
        expect(response!.headers.get('Access-Control-Allow-Methods')).toBe('GET, HEAD, OPTIONS');
        expect(response!.headers.get('Access-Control-Allow-Headers')).toBe('if-none-match');
        expect(response!.headers.get('Vary')).toBe('Access-Control-Request-Headers');
    });

    it('answers non-GET methods with 405 and an Allow header', async () => {
        const response = await serverCardResponse(new Request('https://weather.example.com/mcp/server-card', { method: 'POST' }), {
            card,
            mcpUrl
        });
        expect(response!.status).toBe(405);
        expect(response!.headers.get('Allow')).toBe('GET, HEAD, OPTIONS');
        expect(response!.headers.get('Access-Control-Allow-Origin')).toBe('*');
        expect(await response!.json()).toMatchObject({ error: 'method_not_allowed' });
    });

    it('answers HEAD with the same headers and no body', async () => {
        const response = await serverCardResponse(new Request('https://weather.example.com/mcp/server-card', { method: 'HEAD' }), {
            card,
            mcpUrl
        });
        expect(response!.status).toBe(200);
        expect(response!.headers.get('Content-Type')).toBe(SERVER_CARD_MEDIA_TYPE);
        expect(response!.headers.get('ETag')).toMatch(/^"[0-9a-f]{64}"$/);
        expect(await response!.text()).toBe('');
    });

    it('honors a custom Cache-Control and omits the header for false', async () => {
        const custom = await serverCardResponse(new Request('https://weather.example.com/mcp/server-card'), {
            card,
            mcpUrl,
            cacheControl: 'no-store'
        });
        expect(custom!.headers.get('Cache-Control')).toBe('no-store');
        const omitted = await serverCardResponse(new Request('https://weather.example.com/mcp/server-card'), {
            card,
            mcpUrl,
            cacheControl: false
        });
        expect(omitted!.headers.get('Cache-Control')).toBeNull();
    });

    it('serves a stable strong ETag across calls', async () => {
        const first = await serverCardResponse(new Request('https://weather.example.com/mcp/server-card'), { card, mcpUrl });
        const second = await serverCardResponse(new Request('https://weather.example.com/mcp/server-card'), { card, mcpUrl });
        expect(first!.headers.get('ETag')).toMatch(/^"[0-9a-f]{64}"$/);
        expect(first!.headers.get('ETag')).toBe(second!.headers.get('ETag'));
    });

    it('answers a matching If-None-Match with 304, keeping ETag, CORS, and Cache-Control', async () => {
        const first = await serverCardResponse(new Request('https://weather.example.com/mcp/server-card'), { card, mcpUrl });
        const etag = first!.headers.get('ETag')!;
        for (const headerValue of [etag, `"other", ${etag}`, '*']) {
            const response = await serverCardResponse(
                new Request('https://weather.example.com/mcp/server-card', { headers: { 'If-None-Match': headerValue } }),
                { card, mcpUrl }
            );
            expect(response!.status).toBe(304);
            expect(response!.headers.get('ETag')).toBe(etag);
            expect(response!.headers.get('Access-Control-Allow-Origin')).toBe('*');
            expect(response!.headers.get('Cache-Control')).toBe('public, max-age=3600');
            expect(await response!.text()).toBe('');
        }
    });

    it('serves 200 for a non-matching If-None-Match and ignores conditionals with etag: false', async () => {
        const miss = await serverCardResponse(
            new Request('https://weather.example.com/mcp/server-card', { headers: { 'If-None-Match': '"nope"' } }),
            { card, mcpUrl }
        );
        expect(miss!.status).toBe(200);
        const disabled = await serverCardResponse(
            new Request('https://weather.example.com/mcp/server-card', { headers: { 'If-None-Match': '*' } }),
            { card, mcpUrl, etag: false }
        );
        expect(disabled!.status).toBe(200);
        expect(disabled!.headers.get('ETag')).toBeNull();
    });
});

describe('aiCatalogResponse', () => {
    it('serves the catalog at the well-known path with its media type', async () => {
        const response = await aiCatalogResponse(new Request('https://weather.example.com/.well-known/ai-catalog.json'), { catalog });
        expect(response!.status).toBe(200);
        expect(response!.headers.get('Content-Type')).toBe(AI_CATALOG_MEDIA_TYPE);
        expect(response!.headers.get('Access-Control-Allow-Origin')).toBe('*');
        expect(await response!.json()).toEqual(catalog);
    });

    it('honors a custom path and falls through elsewhere', async () => {
        const custom = await aiCatalogResponse(new Request('https://weather.example.com/catalog.json'), {
            catalog,
            path: '/catalog.json'
        });
        expect(custom!.status).toBe(200);
        expect(
            aiCatalogResponse(new Request('https://weather.example.com/.well-known/ai-catalog.json'), { catalog, path: '/catalog.json' })
        ).toBeUndefined();
        expect(aiCatalogResponse(new Request('https://weather.example.com/elsewhere'), { catalog })).toBeUndefined();
    });

    it('supports conditional requests like the card responder', async () => {
        const first = await aiCatalogResponse(new Request('https://weather.example.com/.well-known/ai-catalog.json'), { catalog });
        const etag = first!.headers.get('ETag')!;
        const revalidated = await aiCatalogResponse(
            new Request('https://weather.example.com/.well-known/ai-catalog.json', { headers: { 'If-None-Match': etag } }),
            { catalog }
        );
        expect(revalidated!.status).toBe(304);
    });
});

describe('serverCardCatalogEntry', () => {
    it('derives the 4-segment URN from the reverse-DNS card name', () => {
        const entry = serverCardCatalogEntry(card, { url: getServerCardUrl(mcpUrl) });
        expect(entry.identifier).toBe('urn:air:example.com:mcp:weather');
        expect(entry.type).toBe(SERVER_CARD_MEDIA_TYPE);
        expect(entry.url).toBe('https://weather.example.com/mcp/server-card');
        expect(entry.data).toBeUndefined();
    });

    it('embeds the card as data for inline entries', () => {
        const entry = serverCardCatalogEntry(card, { inline: true });
        expect(entry.data).toEqual(card);
        expect(entry.url).toBeUndefined();
    });

    it('does not duplicate the card title or description onto the entry', () => {
        const entry = serverCardCatalogEntry(card, { inline: true });
        expect(entry.displayName).toBeUndefined();
        expect(entry.description).toBeUndefined();
    });
});

describe('buildAICatalog', () => {
    it('sets specVersion 1.0 and validates entries', () => {
        expect(catalog.specVersion).toBe('1.0');
        expect(catalog.entries).toHaveLength(1);
        expect(() =>
            buildAICatalog({
                entries: [{ identifier: 'urn:air:example.com:mcp:weather', type: SERVER_CARD_MEDIA_TYPE, url: 'https://x', data: {} }]
            })
        ).toThrow();
    });

    it('carries host information through', () => {
        const withHost = buildAICatalog({ entries: [], host: { displayName: 'Example' } });
        expect(withHost.host).toEqual({ displayName: 'Example' });
    });
});
