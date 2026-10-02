import {
    buildAICatalog,
    buildServerCard,
    getServerCardUrl,
    SERVER_CARD_MEDIA_TYPE,
    serverCardCatalogEntry
} from '@modelcontextprotocol/server/experimental/server-card';
import express from 'express';
import supertest from 'supertest';
import { describe, expect, it } from 'vitest';

import { mcpServerCardRouter } from '../src/experimental/serverCardRouter';

const mcpUrl = new URL('https://weather.example.com/mcp');
const card = buildServerCard({
    name: 'com.example/weather',
    description: 'Forecasts',
    version: '1.0.0',
    remotes: [{ type: 'streamable-http', url: mcpUrl.href }]
});
const catalog = buildAICatalog({ entries: [serverCardCatalogEntry(card, { url: getServerCardUrl(mcpUrl) })] });

function appWith(options: Parameters<typeof mcpServerCardRouter>[0]): express.Express {
    const app = express();
    app.use(mcpServerCardRouter(options));
    app.get('/other', (_req, res) => {
        res.status(200).send('fallthrough');
    });
    return app;
}

describe('mcpServerCardRouter', () => {
    it('serves the card at the reserved path with media type and CORS', async () => {
        const response = await supertest(appWith({ card, mcpUrl })).get('/mcp/server-card');
        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toContain(SERVER_CARD_MEDIA_TYPE);
        expect(response.headers['access-control-allow-origin']).toBe('*');
        expect(response.headers['etag']).toMatch(/^"[0-9a-f]{64}"$/);
        expect(response.body).toEqual(card);
    });

    it('serves the catalog at the well-known path when configured', async () => {
        const app = appWith({ card, mcpUrl, catalog: { catalog } });
        const response = await supertest(app).get('/.well-known/ai-catalog.json');
        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toContain('application/ai-catalog+json');
        expect(response.body).toEqual(catalog);
        const without = await supertest(appWith({ card, mcpUrl })).get('/.well-known/ai-catalog.json');
        expect(without.status).toBe(404);
    });

    it('answers OPTIONS preflight and 405 for non-GET methods', async () => {
        const app = appWith({ card, mcpUrl });
        const preflight = await supertest(app).options('/mcp/server-card').set('Access-Control-Request-Headers', 'if-none-match');
        expect(preflight.status).toBe(204);
        expect(preflight.headers['access-control-allow-methods']).toBe('GET, HEAD, OPTIONS');
        const post = await supertest(app).post('/mcp/server-card');
        expect(post.status).toBe(405);
        expect(post.headers['allow']).toBe('GET, HEAD, OPTIONS');
    });

    it('answers If-None-Match revalidation with 304', async () => {
        const app = appWith({ card, mcpUrl });
        const first = await supertest(app).get('/mcp/server-card');
        const revalidated = await supertest(app).get('/mcp/server-card').set('If-None-Match', first.headers['etag']!);
        expect(revalidated.status).toBe(304);
    });

    it('falls through for unmatched paths', async () => {
        const response = await supertest(appWith({ card, mcpUrl })).get('/other');
        expect(response.status).toBe(200);
        expect(response.text).toBe('fallthrough');
    });
});
