import { SERVER_CARD_SCHEMA_URL, SERVER_CARD_WELL_KNOWN_PATH } from '@modelcontextprotocol/core';
import { describe, expect, it } from 'vitest';

import { createServerCardHandler } from '../../src/experimental/serverCard.js';

const CARD = {
    $schema: SERVER_CARD_SCHEMA_URL,
    name: 'example-org/weather',
    version: '1.0.0',
    description: 'Weather forecasts and alerts.',
    remotes: [{ type: 'streamable-http' as const, url: 'https://mcp.example.com/mcp' }]
};

const CARD_URL = `https://mcp.example.com${SERVER_CARD_WELL_KNOWN_PATH}`;

describe('createServerCardHandler', () => {
    it('throws synchronously when the card is invalid', () => {
        expect(() => createServerCardHandler({ name: 'no-slash' } as never)).toThrow();
    });

    it('serves the card as JSON for a GET on the well-known path', async () => {
        const handler = createServerCardHandler(CARD);
        const res = handler(new Request(CARD_URL));
        expect(res).toBeInstanceOf(Response);
        expect(res!.status).toBe(200);
        expect(res!.headers.get('Content-Type')).toBe('application/json');
        expect(res!.headers.get('Access-Control-Allow-Origin')).toBe('*');
        expect(await res!.json()).toEqual(CARD);
    });

    it('returns undefined for a request to a different path', () => {
        const handler = createServerCardHandler(CARD);
        expect(handler(new Request('https://mcp.example.com/mcp'))).toBeUndefined();
    });

    it('answers OPTIONS preflight requests when CORS is enabled', () => {
        const handler = createServerCardHandler(CARD);
        const res = handler(new Request(CARD_URL, { method: 'OPTIONS' }));
        expect(res!.status).toBe(204);
        expect(res!.headers.get('Access-Control-Allow-Methods')).toContain('GET');
    });

    it.each(['POST', 'PUT', 'DELETE', 'HEAD'])('rejects %s with 405 and an Allow header', method => {
        const handler = createServerCardHandler(CARD);
        const res = handler(new Request(CARD_URL, { method }));
        expect(res!.status).toBe(405);
        expect(res!.headers.get('Allow')).toBe('GET, OPTIONS');
    });

    it('honors a custom path', () => {
        const handler = createServerCardHandler(CARD, { path: '/card' });
        expect(handler(new Request('https://mcp.example.com/card'))).toBeInstanceOf(Response);
        expect(handler(new Request(CARD_URL))).toBeUndefined();
    });

    it('omits CORS headers and rejects OPTIONS when CORS is disabled', () => {
        const handler = createServerCardHandler(CARD, { cors: false });
        const getRes = handler(new Request(CARD_URL));
        expect(getRes!.headers.get('Access-Control-Allow-Origin')).toBeNull();
        expect(handler(new Request(CARD_URL, { method: 'OPTIONS' }))!.status).toBe(405);
    });

    it('strips a packages field down to the Server Card shape', async () => {
        const handler = createServerCardHandler({ ...CARD, packages: [] } as never);
        const res = handler(new Request(CARD_URL));
        expect(await res!.json()).not.toHaveProperty('packages');
    });
});
