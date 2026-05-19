/**
 * Client-side helpers for reading an MCP Server Card (SEP-2127).
 *
 * A Server Card is a static discovery document a remote MCP server publishes at
 * `/.well-known/mcp-server-card`. {@link fetchServerCard} retrieves it, before
 * any session is initialized, and validates it against the Server Card schema
 * so callers always receive a well-formed {@link ServerCard}.
 *
 * WARNING: These APIs are experimental and may change without notice.
 *
 * @see https://github.com/modelcontextprotocol/experimental-ext-server-card
 * @experimental
 * @module
 */

import type { FetchLike, ServerCard } from '@modelcontextprotocol/core';
import { SERVER_CARD_WELL_KNOWN_PATH, ServerCardSchema } from '@modelcontextprotocol/core';

/**
 * Options for {@link fetchServerCard}.
 *
 * @experimental
 */
export interface FetchServerCardOptions {
    /**
     * Custom fetch implementation. Defaults to the global `fetch`.
     */
    fetchFn?: FetchLike;

    /**
     * Abort signal to cancel the underlying request.
     */
    signal?: AbortSignal;

    /**
     * Explicit Server Card URL to fetch. When omitted, the card is fetched from
     * `{origin}/.well-known/mcp-server-card`, derived from `serverUrl`.
     */
    cardUrl?: string | URL;
}

/**
 * Error thrown when a Server Card cannot be fetched (network failure, non-OK
 * HTTP status, or a `404` indicating the server publishes no card). Schema
 * validation failures surface as the underlying `ZodError` instead.
 *
 * @experimental
 */
export class ServerCardFetchError extends Error {
    constructor(
        message: string,
        /** HTTP status code, when the failure was an HTTP error response. */
        readonly status?: number
    ) {
        super(message);
        this.name = 'ServerCardFetchError';
    }
}

/**
 * Fetches and validates the {@link ServerCard} published by a remote MCP server.
 *
 * The card URL defaults to `/.well-known/mcp-server-card` resolved against the
 * origin of `serverUrl`, so you can pass the MCP endpoint URL directly. The
 * fetched document is validated against the Server Card schema; a malformed
 * card rejects the returned promise.
 *
 * @param serverUrl - The MCP server URL (or its origin). Used to derive the
 *   well-known card URL unless {@link FetchServerCardOptions.cardUrl} is set.
 * @throws {ServerCardFetchError} on network failure or a non-OK HTTP response.
 * @throws {z.ZodError} if the fetched document is not a valid Server Card.
 *
 * @example
 * ```ts
 * import { fetchServerCard } from '@modelcontextprotocol/client';
 *
 * const card = await fetchServerCard('https://mcp.example.com/mcp');
 * console.log(card.name, card.version);
 * for (const remote of card.remotes ?? []) {
 *   console.log(remote.type, remote.url);
 * }
 * ```
 *
 * @experimental
 */
export async function fetchServerCard(serverUrl: string | URL, options?: FetchServerCardOptions): Promise<ServerCard> {
    const fetchFn: FetchLike = options?.fetchFn ?? fetch;

    let cardUrl: URL;
    try {
        cardUrl = options?.cardUrl ? new URL(options.cardUrl) : new URL(SERVER_CARD_WELL_KNOWN_PATH, serverUrl);
    } catch {
        throw new ServerCardFetchError(`Invalid server URL: ${String(serverUrl)}`);
    }

    let response: Response;
    try {
        response = await fetchFn(cardUrl, {
            headers: { Accept: 'application/json' },
            signal: options?.signal
        });
    } catch (error) {
        throw new ServerCardFetchError(`Failed to fetch Server Card from ${cardUrl.href}: ${(error as Error).message}`);
    }

    if (!response.ok) {
        await response.text?.().catch(() => {});
        if (response.status === 404) {
            throw new ServerCardFetchError(`Server does not expose a Server Card at ${cardUrl.href} (HTTP 404).`, 404);
        }
        throw new ServerCardFetchError(`Failed to fetch Server Card from ${cardUrl.href}: HTTP ${response.status}.`, response.status);
    }

    let payload: unknown;
    try {
        payload = await response.json();
    } catch {
        throw new ServerCardFetchError(`Server Card at ${cardUrl.href} is not valid JSON.`);
    }

    return ServerCardSchema.parse(payload);
}
