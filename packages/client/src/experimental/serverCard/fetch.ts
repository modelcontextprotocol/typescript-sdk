import type { AICatalog, ServerCard } from '@modelcontextprotocol/core/experimental/server-card';
import {
    AI_CATALOG_MEDIA_TYPE,
    AI_CATALOG_WELL_KNOWN_PATH,
    AICatalogSchema,
    SERVER_CARD_MEDIA_TYPE,
    SERVER_CARD_SCHEMA_URL,
    ServerCardSchema
} from '@modelcontextprotocol/core/experimental/server-card';
import { mediaTypeEssence } from '@modelcontextprotocol/core-internal';

import { ServerCardError } from './errors';
import type { DiscoveryFetchOptions } from './guard';
import { DEFAULT_MAX_RESPONSE_BYTES, guardedFetch, readBodyWithCap } from './guard';

/** Default cap on the number of catalog entries processed. */
export const DEFAULT_MAX_CATALOG_ENTRIES = 100;

/**
 * Options for {@link fetchServerCard}.
 */
export interface FetchServerCardOptions extends DiscoveryFetchOptions {
    /**
     * A previously stored `ETag`, sent as `If-None-Match` so an unchanged
     * document costs a 304.
     */
    etag?: string;
}

/**
 * Result of {@link fetchServerCard}: either the parsed card with the response
 * cache validators, or a `notModified` marker when the server answered 304.
 * The caller owns the cache; `etag` and `cacheControl` are returned verbatim
 * for it.
 */
export type ServerCardFetchResult =
    | { notModified: false; card: ServerCard; url: string; etag?: string; cacheControl?: string }
    | { notModified: true; etag?: string; cacheControl?: string };

/**
 * Fetches and validates a Server Card.
 *
 * Sends `Accept: application/mcp-server-card+json` with no cookies or
 * credentials. A 200 body must have that media type essence or bare
 * `application/json` (static hosts often cannot set custom types); anything
 * else fails with `'invalid-media-type'`. A missing `$schema` is defaulted to
 * the v1 schema URL before validation (lenient ingestion); a wrong `$schema`
 * still fails. A 304 returns `{ notModified: true }`.
 *
 * Card contents are advisory and unverified. Never use them for security or
 * access-control decisions. The URL guards are hostname-level; inject a
 * DNS-pinning `fetch` to defend against DNS rebinding.
 *
 * @throws ServerCardError on guard rejection, HTTP error, oversized body,
 * redirect overflow, unacceptable media type, or an invalid document.
 */
export async function fetchServerCard(url: string | URL, options: FetchServerCardOptions = {}): Promise<ServerCardFetchResult> {
    const { response, url: finalUrl } = await guardedFetch(toUrl(url), SERVER_CARD_MEDIA_TYPE, options, options.etag);
    const preamble = handleCommonStatuses(response, finalUrl);
    if (preamble !== undefined) {
        return preamble;
    }
    const json = await readJsonDocument(response, finalUrl, SERVER_CARD_MEDIA_TYPE, options, 'invalid-server-card');
    return {
        notModified: false,
        card: parseCardDocument(json, finalUrl),
        url: finalUrl,
        ...cacheFields(response)
    };
}

/**
 * Options for {@link fetchAICatalog}.
 */
export interface FetchAICatalogOptions extends DiscoveryFetchOptions {
    /** A previously stored `ETag`, sent as `If-None-Match`. */
    etag?: string;
    /**
     * Cap on the number of entries kept from the catalog. Entries beyond the
     * cap are truncated, not an error. Defaults to 100.
     */
    maxEntries?: number;
}

/**
 * Result of {@link fetchAICatalog}. Same caller-owned cache contract as
 * {@link ServerCardFetchResult}.
 */
export type AICatalogFetchResult =
    | { notModified: false; catalog: AICatalog; url: string; etag?: string; cacheControl?: string }
    | { notModified: true; etag?: string; cacheControl?: string };

/**
 * Fetches and validates an AI Catalog document. Same hardened pipeline as
 * {@link fetchServerCard} with the `application/ai-catalog+json` media type
 * (bare `application/json` tolerated). Nested catalogs are not followed.
 *
 * @throws ServerCardError with code `'invalid-ai-catalog'` on an invalid
 * document, plus the same transport error codes as {@link fetchServerCard}.
 */
export async function fetchAICatalog(url: string | URL, options: FetchAICatalogOptions = {}): Promise<AICatalogFetchResult> {
    const { response, url: finalUrl } = await guardedFetch(toUrl(url), AI_CATALOG_MEDIA_TYPE, options, options.etag);
    const preamble = handleCommonStatuses(response, finalUrl);
    if (preamble !== undefined) {
        return preamble;
    }
    const json = await readJsonDocument(response, finalUrl, AI_CATALOG_MEDIA_TYPE, options, 'invalid-ai-catalog');
    const parsed = AICatalogSchema.safeParse(json);
    if (!parsed.success) {
        throw new ServerCardError('invalid-ai-catalog', `AI Catalog document from ${finalUrl} failed validation`, {
            url: finalUrl,
            cause: parsed.error
        });
    }
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_CATALOG_ENTRIES;
    const catalog =
        parsed.data.entries.length > maxEntries ? { ...parsed.data, entries: parsed.data.entries.slice(0, maxEntries) } : parsed.data;
    return { notModified: false, catalog, url: finalUrl, ...cacheFields(response) };
}

/**
 * Computes the well-known AI Catalog URL for a domain or URL:
 * `'example.com'` and `'https://example.com/anything'` both become
 * `https://example.com/.well-known/ai-catalog.json`. Bare domains get
 * `https://`.
 */
export function getAICatalogUrl(domainOrUrl: string | URL): URL {
    return new URL(AI_CATALOG_WELL_KNOWN_PATH, toUrl(domainOrUrl));
}

/** Lenient card ingestion: default a missing $schema, then validate. */
export function parseCardDocument(json: unknown, url: string): ServerCard {
    const withSchema =
        json !== null && typeof json === 'object' && !Array.isArray(json) && !('$schema' in json)
            ? { $schema: SERVER_CARD_SCHEMA_URL, ...json }
            : json;
    const parsed = ServerCardSchema.safeParse(withSchema);
    if (!parsed.success) {
        throw new ServerCardError('invalid-server-card', `Server Card document from ${url} failed validation`, {
            url,
            cause: parsed.error
        });
    }
    return parsed.data;
}

function toUrl(value: string | URL): URL {
    if (value instanceof URL) {
        return new URL(value.href);
    }
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
    try {
        return new URL(withScheme);
    } catch (error) {
        throw new ServerCardError('invalid-url', `Invalid discovery URL: ${value}`, { url: value, cause: error });
    }
}

function handleCommonStatuses(response: Response, url: string): { notModified: true; etag?: string; cacheControl?: string } | undefined {
    if (response.status === 304) {
        return { notModified: true, ...cacheFields(response) };
    }
    if (response.status < 200 || response.status >= 300) {
        throw new ServerCardError('http-error', `Request to ${url} failed with status ${response.status}`, {
            url,
            status: response.status
        });
    }
    return undefined;
}

async function readJsonDocument(
    response: Response,
    url: string,
    canonicalMediaType: string,
    options: DiscoveryFetchOptions,
    invalidCode: 'invalid-server-card' | 'invalid-ai-catalog'
): Promise<unknown> {
    const body = await readBodyWithCap(response, url, options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES);
    const essence = mediaTypeEssence(response.headers.get('content-type'));
    if (essence !== canonicalMediaType && essence !== 'application/json') {
        throw new ServerCardError('invalid-media-type', `Expected ${canonicalMediaType} from ${url}, got ${essence ?? 'no media type'}`, {
            url,
            mediaType: essence
        });
    }
    try {
        return JSON.parse(body) as unknown;
    } catch (error) {
        throw new ServerCardError(invalidCode, `Response from ${url} is not valid JSON`, { url, cause: error });
    }
}

function cacheFields(response: Response): { etag?: string; cacheControl?: string } {
    return {
        ...(response.headers.get('etag') === null ? {} : { etag: response.headers.get('etag')! }),
        ...(response.headers.get('cache-control') === null ? {} : { cacheControl: response.headers.get('cache-control')! })
    };
}
