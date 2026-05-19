import { SERVER_CARD_SCHEMA_URL } from '@modelcontextprotocol/server';
import express from 'express';
import supertest from 'supertest';
import { describe, expect, it } from 'vitest';

import { mcpServerCardRouter } from '../src/serverCard.js';

const CARD = {
    $schema: SERVER_CARD_SCHEMA_URL,
    name: 'example-org/weather',
    version: '1.0.0',
    description: 'Weather forecasts and alerts.',
    remotes: [{ type: 'streamable-http' as const, url: 'https://mcp.example.com/mcp' }]
};

describe('mcpServerCardRouter', () => {
    it('serves the Server Card at the well-known path', async () => {
        const app = express();
        app.use(mcpServerCardRouter(CARD));

        const res = await supertest(app).get('/.well-known/mcp-server-card');
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/application\/json/);
        expect(res.body).toEqual(CARD);
    });

    it('enables CORS so browser clients can read the card', async () => {
        const app = express();
        app.use(mcpServerCardRouter(CARD));

        const res = await supertest(app).get('/.well-known/mcp-server-card');
        expect(res.headers['access-control-allow-origin']).toBe('*');
    });

    it('rejects non-GET methods with 405', async () => {
        const app = express();
        app.use(mcpServerCardRouter(CARD));

        const res = await supertest(app).post('/.well-known/mcp-server-card');
        expect(res.status).toBe(405);
        expect(res.headers.allow).toBe('GET, OPTIONS');
    });

    it('throws when the card fails schema validation', () => {
        expect(() => mcpServerCardRouter({ name: 'no-slash' } as never)).toThrow();
    });

    it('honors a custom path', async () => {
        const app = express();
        app.use(mcpServerCardRouter(CARD, { path: '/card' }));

        expect((await supertest(app).get('/card')).status).toBe(200);
        expect((await supertest(app).get('/.well-known/mcp-server-card')).status).toBe(404);
    });
});
