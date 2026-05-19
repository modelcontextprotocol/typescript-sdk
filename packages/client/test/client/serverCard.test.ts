import type { FetchLike } from '@modelcontextprotocol/core';
import { SERVER_CARD_SCHEMA_URL } from '@modelcontextprotocol/core';
import { describe, expect, it, vi } from 'vitest';

import { fetchServerCard, ServerCardFetchError } from '../../src/experimental/serverCard.js';

const CARD = {
    $schema: SERVER_CARD_SCHEMA_URL,
    name: 'example-org/weather',
    version: '1.0.0',
    description: 'Weather forecasts and alerts.'
};

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('fetchServerCard', () => {
    it('fetches the card from the well-known path derived from the server URL', async () => {
        const fetchFn = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(CARD));

        const card = await fetchServerCard('https://mcp.example.com/mcp', { fetchFn });

        expect(card).toEqual(CARD);
        expect(fetchFn).toHaveBeenCalledTimes(1);
        expect(String(fetchFn.mock.calls[0]![0])).toBe('https://mcp.example.com/.well-known/mcp-server-card');
    });

    it('accepts an explicit cardUrl override', async () => {
        const fetchFn = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(CARD));

        await fetchServerCard('https://mcp.example.com', { fetchFn, cardUrl: 'https://cards.example.com/weather.json' });

        expect(String(fetchFn.mock.calls[0]![0])).toBe('https://cards.example.com/weather.json');
    });

    it('sends an Accept: application/json header', async () => {
        const fetchFn = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(CARD));

        await fetchServerCard('https://mcp.example.com', { fetchFn });

        const init = fetchFn.mock.calls[0]![1];
        expect(new Headers(init?.headers).get('Accept')).toBe('application/json');
    });

    it('throws ServerCardFetchError with status 404 when no card is published', async () => {
        const fetchFn = vi.fn<FetchLike>().mockResolvedValue(new Response('not found', { status: 404 }));

        await expect(fetchServerCard('https://mcp.example.com', { fetchFn })).rejects.toMatchObject({
            name: 'ServerCardFetchError',
            status: 404
        });
    });

    it('throws ServerCardFetchError on a non-OK HTTP response', async () => {
        const fetchFn = vi.fn<FetchLike>().mockResolvedValue(new Response('boom', { status: 503 }));

        await expect(fetchServerCard('https://mcp.example.com', { fetchFn })).rejects.toBeInstanceOf(ServerCardFetchError);
    });

    it('throws ServerCardFetchError when the network request fails', async () => {
        const fetchFn = vi.fn<FetchLike>().mockRejectedValue(new TypeError('network down'));

        await expect(fetchServerCard('https://mcp.example.com', { fetchFn })).rejects.toBeInstanceOf(ServerCardFetchError);
    });

    it('throws ServerCardFetchError when the body is not valid JSON', async () => {
        const fetchFn = vi.fn<FetchLike>().mockResolvedValue(new Response('<html>', { status: 200 }));

        await expect(fetchServerCard('https://mcp.example.com', { fetchFn })).rejects.toBeInstanceOf(ServerCardFetchError);
    });

    it('throws a validation error when the fetched document is not a valid Server Card', async () => {
        const fetchFn = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ name: 'missing-fields' }));

        await expect(fetchServerCard('https://mcp.example.com', { fetchFn })).rejects.toThrow();
    });
});
